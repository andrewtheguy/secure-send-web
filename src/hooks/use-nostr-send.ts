import type { Event } from 'nostr-tools';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  computePinHint,
  decrypt,
  deriveNostrTransferKeysFromPin,
  encrypt,
  generatePin,
  generateSalt,
  generateTransferId,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { readFileAsBytes } from '@/lib/file-utils';
import {
  type ContentType,
  createNostrClient,
  createPinExchangeEvent,
  createSignalingEvent,
  DEFAULT_RELAYS,
  EVENT_KIND_DATA_TRANSFER,
  generateEphemeralKeys,
  type NostrClient,
  type PinExchangePayload,
  parseAckEvent,
  parseSignalingEvent,
  type TransferState,
  verifyAuthenticatedAckEvent,
} from '@/lib/nostr';
import { sendFileOverDataChannel } from '@/lib/p2p-transfer';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

export interface UseNostrSendReturn {
  state: TransferState;
  pin: string | null;
  send: (content: File) => Promise<void>;
  cancel: () => void;
}

export function useNostrSend(): UseNostrSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [pin, setPin] = useState<string | null>(null);

  const clientRef = useRef<NostrClient | null>(null);
  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearExpirationTimeout = useCallback(() => {
    if (expirationTimeoutRef.current) {
      clearTimeout(expirationTimeoutRef.current);
      expirationTimeoutRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    clearExpirationTimeout();
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    setPin(null);
    setState({ status: 'idle' });
  }, [clearExpirationTimeout]);

  const send = useCallback(
    async (content: File) => {
      // Guard against concurrent invocations
      if (sendingRef.current) return;
      sendingRef.current = true;
      cancelledRef.current = false;

      const contentType: ContentType = 'file';

      try {
        // Validate and sanitize metadata
        const rawFileName = content.name || '';
        const sanitizedFileName = rawFileName.trim();

        if (!sanitizedFileName) {
          setState({ status: 'error', message: 'Missing file name' });
          sendingRef.current = false;
          return;
        }

        const fileName = sanitizedFileName;
        const fileSize = content.size;
        const mimeType = content.type || 'application/octet-stream';

        if (typeof fileSize !== 'number' || !Number.isFinite(fileSize)) {
          setState({ status: 'error', message: 'Invalid file size' });
          sendingRef.current = false;
          return;
        }

        if (fileSize <= 0) {
          setState({ status: 'error', message: 'File is empty' });
          sendingRef.current = false;
          return;
        }

        if (fileSize > MAX_MESSAGE_SIZE) {
          const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024;
          setState({
            status: 'error',
            message: `File exceeds ${limitMB}MB limit`,
          });
          sendingRef.current = false;
          return;
        }

        setState({ status: 'connecting', message: 'Reading file...' });
        const contentBytes = await readFileAsBytes(content);

        // Generate credentials and derive labeled transfer keys
        const sessionStartTime = Date.now();
        const salt = generateSalt();

        // Auto Exchange mode
        setState({ status: 'connecting', message: 'Generating secure PIN...' });
        const newPin = generatePin();
        const hint = await computePinHint(newPin);
        const keys = await deriveNostrTransferKeysFromPin(newPin, salt);
        setPin(newPin);

        // Best-effort cleanup: clear state after expiration
        clearExpirationTimeout();
        expirationTimeoutRef.current = setTimeout(() => {
          if (!cancelledRef.current && sendingRef.current) {
            setPin(null);
            setState({
              status: 'error',
              message: 'Session expired. Please try again.',
            });
            sendingRef.current = false;
            if (clientRef.current) {
              clientRef.current.close();
              clientRef.current = null;
            }
          }
        }, TRANSFER_EXPIRATION_MS);

        if (cancelledRef.current) return;

        // Generate ephemeral Nostr keypair
        const { secretKey, publicKey } = generateEphemeralKeys();
        const transferId = generateTransferId();

        if (cancelledRef.current) return;

        // Create Nostr client for signaling
        setState({ status: 'connecting', message: 'Connecting to relays...' });
        const client = createNostrClient([...DEFAULT_RELAYS]);
        clientRef.current = client;

        // Create payload
        const payload: PinExchangePayload = {
          contentType,
          transferId,
          senderPubkey: publicKey,
          relays: [...DEFAULT_RELAYS],
          fileName,
          fileSize,
          mimeType,
        };

        const encoder = new TextEncoder();
        const payloadBytes = encoder.encode(JSON.stringify(payload));
        const encryptedPayload = await encrypt(keys.metadata, payloadBytes);

        // Publish exchange event
        setState({
          status: 'waiting_for_receiver',
          message: 'Waiting for receiver...',
          contentType,
          fileMetadata: { fileName, fileSize, mimeType },
          useWebRTC: true,
          currentRelays: client.getRelays(),
          totalRelays: DEFAULT_RELAYS.length,
        });

        const exchangeEvent = createPinExchangeEvent(
          secretKey,
          encryptedPayload,
          salt,
          transferId,
          hint,
        );

        await client.publish(exchangeEvent);

        if (cancelledRef.current) return;

        // Ensure connection is ready before subscribing
        await client.waitForConnection();

        // Wait for receiver ready ACK (seq=0)
        const { receiverPubkey } = await new Promise<{
          receiverPubkey: string;
        }>((resolve, reject) => {
          const timeout = setTimeout(
            () => {
              client.unsubscribe(subId);
              if (!cancelledRef.current) {
                reject(new Error('Timeout waiting for receiver'));
              }
            },
            60 * 60 * 1000,
          ); // 1 hour timeout

          const subId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId],
                '#p': [publicKey],
              },
            ],
            (event) => {
              if (cancelledRef.current) {
                clearTimeout(timeout);
                client.unsubscribe(subId);
                reject(new Error('Cancelled'));
                return;
              }

              const ack = parseAckEvent(event);
              if (ack && ack.transferId === transferId && ack.seq === 0) {
                void (async () => {
                  const verified = await verifyAuthenticatedAckEvent(
                    event,
                    keys.signals,
                    transferId,
                    0,
                  );
                  if (!verified) return;

                  clearTimeout(timeout);
                  client.unsubscribe(subId);
                  resolve({
                    receiverPubkey: event.pubkey,
                  });
                })();
              }
            },
          );
        });

        if (cancelledRef.current) return;

        // Receiver connected - credentials no longer needed for display
        setPin(null);

        // Enforce TTL: reject if session has expired
        if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
          throw new Error('Session expired. Please start a new transfer.');
        }

        // WebRTC Transfer Logic (P2P only — no cloud fallback)
        let webRTCSuccess = false;

        try {
          setState((prevState) => ({
            ...prevState,
            status: 'connecting',
            message: 'Attempting P2P connection...',
          }));

          await new Promise<void>((resolve, reject) => {
            let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
            let offerRetryInterval: ReturnType<typeof setInterval> | null =
              null;
            let signalSubId: string | null = null;
            let answerReceived = false;
            const processedEventIds = new Set<string>();

            const processSignalEvent = async (event: Event) => {
              if (processedEventIds.has(event.id)) return;
              processedEventIds.add(event.id);

              const signalData = parseSignalingEvent(event);
              if (signalData && signalData.transferId === transferId) {
                try {
                  const decrypted = await decrypt(
                    keys.signals,
                    signalData.encryptedSignal,
                  );
                  const signalPayload = JSON.parse(
                    new TextDecoder().decode(decrypted),
                  );
                  if (signalPayload.type === 'signal' && signalPayload.signal) {
                    if (signalPayload.signal.type === 'answer') {
                      answerReceived = true;
                      if (offerRetryInterval) {
                        clearInterval(offerRetryInterval);
                        offerRetryInterval = null;
                      }
                    }
                    await rtc.handleSignal(signalPayload.signal);
                  }
                } catch (err) {
                  console.error('Failed to process signaling event:', err);
                }
              }
            };

            const cleanup = () => {
              if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
              }
              if (offerRetryInterval) {
                clearInterval(offerRetryInterval);
                offerRetryInterval = null;
              }
              if (signalSubId) {
                client.unsubscribe(signalSubId);
                signalSubId = null;
              }
            };

            const rtc = new WebRTCConnection(
              getWebRTCConfig(),
              async (signal) => {
                if (cancelledRef.current) return;
                const signalPayload = { type: 'signal', signal };
                const signalJson = JSON.stringify(signalPayload);
                const encryptedSignal = await encrypt(
                  keys.signals,
                  new TextEncoder().encode(signalJson),
                );
                const event = createSignalingEvent(
                  secretKey,
                  publicKey,
                  transferId,
                  encryptedSignal,
                );
                await client.publish(event);
              },
              async () => {
                if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
                  try {
                    rtc.close();
                  } catch {
                    // ignore
                  }
                  cleanup();
                  reject(
                    new Error('Session expired. Please start a new transfer.'),
                  );
                  return;
                }

                cleanup();

                setState((prevState) => ({
                  status: 'transferring',
                  message: 'Sending via P2P...',
                  progress: { current: 0, total: contentBytes.length },
                  contentType,
                  fileMetadata: { fileName, fileSize, mimeType },
                  currentRelays: prevState.currentRelays,
                  totalRelays: prevState.totalRelays,
                  useWebRTC: true,
                }));

                try {
                  // After the data channel is open, nostr is no longer involved:
                  // completion is the data-channel ACK awaited here.
                  await sendFileOverDataChannel(
                    rtc,
                    keys.p2pContent,
                    contentBytes,
                    {
                      onProgress: (current, total) =>
                        setState((s) => ({
                          ...s,
                          progress: { current, total },
                        })),
                      isCancelled: () => cancelledRef.current,
                    },
                  );
                  webRTCSuccess = true;
                  resolve();
                } catch (err) {
                  reject(err);
                } finally {
                  // The local peer connection is scoped to this Promise and is
                  // not reachable from the outer catch/finally, so close it here
                  // on success, error, or cancellation to avoid leaking it.
                  try {
                    rtc.close();
                  } catch {
                    // ignore
                  }
                }
              },
              () => {
                // Data-channel messages are not used by the auto-mode sender.
              },
            );

            signalSubId = client.subscribe(
              [
                {
                  kinds: [EVENT_KIND_DATA_TRANSFER],
                  '#t': [transferId],
                  '#p': [publicKey],
                  authors: [receiverPubkey],
                },
              ],
              processSignalEvent,
            );

            const queryForExistingSignals = async () => {
              try {
                const existingEvents = await client.query([
                  {
                    kinds: [EVENT_KIND_DATA_TRANSFER],
                    '#t': [transferId],
                    '#p': [publicKey],
                    authors: [receiverPubkey],
                    limit: 50,
                  },
                ]);
                for (const event of existingEvents) {
                  await processSignalEvent(event);
                }
              } catch (err) {
                console.error('Failed to query existing signal events:', err);
              }
            };

            rtc.createDataChannel('file-transfer');
            void rtc.createOffer();
            void queryForExistingSignals();

            let retryCount = 0;
            offerRetryInterval = setInterval(async () => {
              if (answerReceived || webRTCSuccess || cancelledRef.current) {
                if (offerRetryInterval) {
                  clearInterval(offerRetryInterval);
                  offerRetryInterval = null;
                }
                return;
              }

              retryCount++;
              console.log(
                `Retrying WebRTC offer (attempt ${retryCount + 1})...`,
              );
              await queryForExistingSignals();
              if (!answerReceived && !webRTCSuccess) {
                void rtc.createOffer();
              }
            }, 5000);

            connectionTimeout = setTimeout(() => {
              if (!webRTCSuccess) {
                cleanup();
                rtc.close();
                reject(new P2PConnectionError('WebRTC connection timeout'));
              }
            }, 30000);
          });
        } catch (err) {
          const message = `P2P transfer failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
          // Preserve the connection-failure distinction so the UI can suggest
          // the offline-QR fallback only when P2P could not be established.
          throw err instanceof P2PConnectionError
            ? new P2PConnectionError(message)
            : new Error(message);
        }

        // Completion is confirmed by the data-channel ACK (awaited inside
        // sendFileOverDataChannel). Nostr is not involved past signaling.
        setState((prevState) => ({
          status: 'complete',
          message: 'File sent via P2P!',
          contentType,
          currentRelays: prevState.currentRelays,
          totalRelays: prevState.totalRelays,
          useWebRTC: prevState.useWebRTC,
        }));
      } catch (error) {
        if (!cancelledRef.current) {
          setPin(null);
          setState((prevState) => ({
            ...prevState,
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to send',
            connectionFailed: error instanceof P2PConnectionError,
          }));
        }
      } finally {
        clearExpirationTimeout();
        sendingRef.current = false;
        if (clientRef.current) {
          clientRef.current.close();
          clientRef.current = null;
        }
      }
    },
    [clearExpirationTimeout],
  );

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, pin, send, cancel }),
    [state, pin, send, cancel],
  );
}
