import type { Event } from 'nostr-tools';
import { useCallback, useRef, useState } from 'react';
import {
  computePinHintFromKey,
  decrypt,
  deriveNostrTransferKeysFromPinKey,
  encrypt,
  MAX_MESSAGE_SIZE,
  type NostrTransferKeys,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import {
  createAuthenticatedAckEvent,
  createNostrClient,
  createSignalingEvent,
  DEFAULT_RELAYS,
  EVENT_KIND_DATA_TRANSFER,
  EVENT_KIND_PIN_EXCHANGE,
  generateEphemeralKeys,
  type NostrClient,
  type PinExchangePayload,
  parsePinExchangeEvent,
  parseSignalingEvent,
  type TransferState,
} from '@/lib/nostr';
import { ACK, createDataChannelReceiver } from '@/lib/p2p-transfer';
import type { PinKeyMaterial, ReceivedContent } from '@/lib/types';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

export interface UseNostrReceiveReturn {
  state: TransferState;
  receivedContent: ReceivedContent | null;
  receive: (pinMaterial: PinKeyMaterial) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useNostrReceive(): UseNostrReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);

  const clientRef = useRef<NostrClient | null>(null);
  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    receivingRef.current = false;
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    setState({ status: 'idle' });
  }, []);

  const reset = useCallback(() => {
    cancel();
    setReceivedContent(null);
  }, [cancel]);

  const receive = useCallback(async (pinMaterial: PinKeyMaterial) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return;
    receivingRef.current = true;
    cancelledRef.current = false;
    setReceivedContent(null);

    try {
      let keys: NostrTransferKeys | null = null;

      // Auto Exchange mode: use provided material
      if (!pinMaterial.key || !pinMaterial.fingerprint) {
        setState({
          status: 'error',
          message: 'PIN unavailable. Please re-enter.',
        });
        receivingRef.current = false;
        return;
      }
      setState({
        status: 'connecting',
        message: 'Deriving encryption keys...',
      });

      // The PIN hint is salted with the current time bucket, so the sender's hint is
      // tied to the bucket it published in. Derive both the current and previous bucket
      // hints and query for either, so a transfer created just before a bucket rollover
      // is still found (one look-back covers the whole non-expired window, since the
      // bucket width equals the transfer lifetime). Mirrors the QR signaling parser,
      // which de-obfuscates against the current and previous time bucket.
      const [hintCurrent, hintPrev] = await Promise.all([
        computePinHintFromKey(pinMaterial.key, 0),
        computePinHintFromKey(pinMaterial.key, 1),
      ]);

      if (cancelledRef.current) return;

      // Connect to relays
      setState({ status: 'connecting', message: 'Connecting to relays...' });
      const client = createNostrClient([...DEFAULT_RELAYS]);
      clientRef.current = client;

      if (cancelledRef.current) return;

      // Search for exchange event
      setState({ status: 'receiving', message: 'Searching for sender...' });

      // Query for events matching the current or previous time-bucket hint
      const events = await client.query([
        {
          kinds: [EVENT_KIND_PIN_EXCHANGE],
          '#h': [hintCurrent, hintPrev],
          limit: 10,
        },
      ]);

      if (cancelledRef.current) return;

      if (events.length === 0) {
        setState({
          status: 'error',
          message: 'No transfer found for this PIN',
        });
        return;
      }

      // Try to decrypt each event
      let payload: PinExchangePayload | null = null;
      let transferId: string | null = null;
      let senderPubkey: string | null = null;
      let sawExpiredCandidate = false;
      let sawNonExpiredCandidate = false;
      let selectedCreatedAtSec: number | null = null;
      let matchedHint: string = hintCurrent;

      const sortedEvents = [...events].sort(
        (a, b) => (b.created_at || 0) - (a.created_at || 0),
      );

      for (const event of sortedEvents) {
        // Enforce TTL
        if (!event.created_at) {
          sawExpiredCandidate = true;
          continue;
        }
        const eventAgeMs = Date.now() - event.created_at * 1000;
        if (eventAgeMs > TRANSFER_EXPIRATION_MS) {
          sawExpiredCandidate = true;
          continue;
        }
        sawNonExpiredCandidate = true;

        // Auto Exchange mode
        const parsed = parsePinExchangeEvent(event);
        if (!parsed) continue;

        try {
          const derivedKeys = await deriveNostrTransferKeysFromPinKey(
            pinMaterial.key,
            parsed.salt,
          );
          const decrypted = await decrypt(
            derivedKeys.metadata,
            parsed.encryptedPayload,
          );
          const decoder = new TextDecoder();
          const payloadStr = decoder.decode(decrypted);
          payload = JSON.parse(payloadStr) as PinExchangePayload;

          transferId = parsed.transferId;
          senderPubkey = event.pubkey;
          keys = derivedKeys;
          selectedCreatedAtSec = event.created_at || null;
          // Echo back the exact hint the sender published (current or previous bucket)
          matchedHint = parsed.hint;
          break;
        } catch {
          // Silently ignore decryption failures and continue trying other candidates.
          // A failure here just means this event wasn't encrypted with our PIN key
          // (wrong/stale event sharing the same hint), not a real error.
        }
      }

      if (!payload || !keys) {
        if (!sawNonExpiredCandidate && sawExpiredCandidate) {
          setState({
            status: 'error',
            message: 'Transfer expired. Ask sender to start a new transfer.',
          });
          return;
        }
        setState({
          status: 'error',
          message: 'Could not decrypt transfer. Wrong PIN?',
        });
        return;
      }

      if (!transferId || !senderPubkey) {
        if (!sawNonExpiredCandidate && sawExpiredCandidate) {
          setState({
            status: 'error',
            message: 'Transfer expired. Ask sender to start a new transfer.',
          });
          return;
        }
        setState({
          status: 'error',
          message: 'Could not decrypt transfer. Wrong PIN?',
        });
        return;
      }

      if (
        !selectedCreatedAtSec ||
        Date.now() - selectedCreatedAtSec * 1000 > TRANSFER_EXPIRATION_MS
      ) {
        setState({
          status: 'error',
          message: 'Transfer expired. Ask sender to generate a new PIN.',
        });
        return;
      }

      if (cancelledRef.current) return;

      // Validate payload
      if (
        payload.fileSize == null ||
        !Number.isFinite(payload.fileSize) ||
        payload.fileSize < 0
      ) {
        setState({ status: 'error', message: 'Invalid file size in transfer' });
        return;
      }

      const resolvedFileName = payload.fileName || 'unknown';
      const resolvedFileSize = payload.fileSize;
      const resolvedMimeType = payload.mimeType || 'application/octet-stream';

      if (resolvedFileSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(resolvedFileSize / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`,
        });
        return;
      }

      // Generate receiver keypair only after the decrypted metadata is accepted.
      const { secretKey } = generateEphemeralKeys();

      // Send ready ACK (seq=0), authenticated with the PIN-derived signals key.
      const readyAck = await createAuthenticatedAckEvent(
        secretKey,
        senderPubkey,
        transferId,
        0,
        keys.signals,
        matchedHint,
      );
      await client.publish(readyAck);

      if (cancelledRef.current) return;

      setState({
        status: 'receiving',
        message: 'Receiving file...',
        contentType: 'file',
        fileMetadata: {
          fileName: resolvedFileName,
          fileSize: resolvedFileSize,
          mimeType: resolvedMimeType,
        },
        useWebRTC: false,
        currentRelays: client.getRelays(),
        totalRelays: DEFAULT_RELAYS.length,
      });

      // Listener for the P2P transfer
      const transferResult = await new Promise<Uint8Array>(
        (resolve, reject) => {
          let rtc: WebRTCConnection | null = null;
          let settled = false;

          // Streaming receiver: decrypts each chunk into a single preallocated
          // buffer as it arrives. Nostr is not involved past signaling; the
          // data-channel ACK below confirms completion.
          const receiver = createDataChannelReceiver(
            keys!.p2pContent,
            resolvedFileSize,
            {
              onProgress: (current, total) =>
                setState((s) => ({
                  ...s,
                  status: 'receiving',
                  progress: { current, total },
                })),
            },
          );

          let cancelPoll: ReturnType<typeof setInterval> | null = null;

          // cancel() only flips cancelledRef and closes the relay client; rtc is
          // local to this Promise and unreachable from there. Poll so a cancel
          // always settles the wait, even when rtc cannot be closed by cancel().
          // A stalled stream is aborted by the receiver's own idle watchdog.
          cancelPoll = setInterval(() => {
            if (cancelledRef.current && !settled) {
              settled = true;
              receiver.dispose();
              if (cancelPoll) clearInterval(cancelPoll);
              client.unsubscribe(subId);
              try {
                if (rtc) rtc.close();
              } catch {
                // ignore
              }
              reject(new Error('Cancelled'));
            }
          }, 250);

          receiver.done
            .then((result) => {
              if (settled) return;
              settled = true;
              if (cancelPoll) clearInterval(cancelPoll);
              client.unsubscribe(subId);
              // The file is fully received; a failure to send the ACK or tear
              // down rtc must not prevent the Promise from settling.
              try {
                if (rtc) {
                  rtc.send(ACK);
                  rtc.close();
                }
              } catch (e) {
                console.error('ACK/teardown error', e);
              }
              resolve(result);
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              if (cancelPoll) clearInterval(cancelPoll);
              client.unsubscribe(subId);
              try {
                if (rtc) rtc.close();
              } catch {
                // ignore
              }
              reject(err instanceof Error ? err : new Error('Transfer failed'));
            });

          const initWebRTC = () => {
            if (rtc) return rtc;

            rtc = new WebRTCConnection(
              getWebRTCConfig(),
              async (signal) => {
                const signalPayload = { type: 'signal', signal };
                const signalJson = JSON.stringify(signalPayload);
                const encryptedSignal = await encrypt(
                  keys!.signals,
                  new TextEncoder().encode(signalJson),
                );
                const event = createSignalingEvent(
                  secretKey,
                  senderPubkey!,
                  transferId!,
                  encryptedSignal,
                );
                await client.publish(event);
              },
              () => {
                // Data channel opened; the idle watchdog covers the receiving
                // stage from here on.
                receiver.start();
                setState((s) => ({
                  ...s,
                  message: 'Receiving via P2P...',
                  useWebRTC: true,
                }));
              },
              (data) => {
                if (settled) return;
                receiver.onMessage(data);
              },
            );
            return rtc;
          };

          const processedEventIds = new Set<string>();

          const processEvent = async (event: Event) => {
            if (settled) return;
            if (processedEventIds.has(event.id)) return;
            processedEventIds.add(event.id);

            const signalData = parseSignalingEvent(event);
            if (signalData && signalData.transferId === transferId) {
              try {
                const decrypted = await decrypt(
                  keys!.signals,
                  signalData.encryptedSignal,
                );
                const signalPayload = JSON.parse(
                  new TextDecoder().decode(decrypted),
                );
                if (signalPayload.type === 'signal' && signalPayload.signal) {
                  const r = initWebRTC();
                  await r.handleSignal(signalPayload.signal);
                }
              } catch (e) {
                console.error('Signal handling error', e);
              }
            }
          };

          const subId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId!],
                authors: [senderPubkey!],
              },
            ],
            processEvent,
          );

          // Fire-and-forget: Query existing events in parallel with the live subscription.
          // This catches events published before we subscribed. Errors are logged inside.
          void (async () => {
            try {
              const existingEvents = await client.query([
                {
                  kinds: [EVENT_KIND_DATA_TRANSFER],
                  '#t': [transferId!],
                  authors: [senderPubkey!],
                  limit: 50,
                },
              ]);
              for (const event of existingEvents) {
                await processEvent(event);
              }
            } catch (err) {
              console.error('Failed to query existing events:', err);
            }
          })();
        },
      );

      if (cancelledRef.current) return;

      // P2P transfer streams already-decrypted chunks into the result buffer.
      const contentData = transferResult;

      if (cancelledRef.current) return;

      // Completion is confirmed to the sender via the data-channel ACK sent when
      // receiver.done resolved; no relay event is published post-transfer.

      // Set received content
      setReceivedContent({
        contentType: 'file',
        data: contentData,
        fileName: resolvedFileName,
        fileSize: resolvedFileSize,
        mimeType: resolvedMimeType,
      });

      setState((prevState) => ({
        status: 'complete',
        message: 'File received (P2P)!',
        contentType: 'file',
        fileMetadata: {
          fileName: resolvedFileName,
          fileSize: resolvedFileSize,
          mimeType: resolvedMimeType,
        },
        currentRelays: prevState.currentRelays,
        totalRelays: prevState.totalRelays,
        useWebRTC: prevState.useWebRTC,
      }));
    } catch (error) {
      if (!cancelledRef.current) {
        setState((prevState) => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
          connectionFailed: error instanceof P2PConnectionError,
        }));
      }
    } finally {
      receivingRef.current = false;
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
    }
  }, []);

  return { state, receivedContent, receive, cancel, reset };
}
