import type { Event } from 'nostr-tools';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  computePinFingerprintFromRoot,
  computePinHintFromRoot,
  decrypt,
  deriveNostrSessionKeys,
  derivePinAuthKey,
  derivePinRendezvousKey,
  deriveSharedSecretKey,
  encrypt,
  formatPinHint,
  generateECDHKeyPair,
  generatePin,
  generateSalt,
  generateTransferId,
  importPinRoot,
  MAX_MESSAGE_SIZE,
  type NostrSessionKeys,
  PIN_ACTIVE_GENERATIONS,
  PIN_DISPLAY_TIMEOUT_MS,
  PIN_ROTATION_MS,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { readFileAsBytes } from '@/lib/file-utils';
import {
  base64ToUint8Array,
  type ClaimPayload,
  type ConfirmPayload,
  type ContentType,
  createHandshakeEvent,
  createNostrClient,
  createRendezvousEvent,
  createSignalingEvent,
  DEFAULT_RELAYS,
  EVENT_KIND_DATA_TRANSFER,
  generateEphemeralKeys,
  generateHandshakeNonce,
  type NostrClient,
  openHandshakePayload,
  parseHandshakeEvent,
  parseSignalingEvent,
  type RendezvousPayload,
  sealHandshakePayload,
  type TransferState,
  uint8ArrayToBase64,
} from '@/lib/nostr';
import { sendFileOverDataChannel } from '@/lib/p2p-transfer';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

/**
 * One rotation generation of the displayed PIN. The sender retains the
 * PIN_ACTIVE_GENERATIONS most recent so a PIN read just before a rotation
 * still authenticates the receiver's claim.
 */
interface PinGeneration {
  authKey: CryptoKey;
  nonce: string;
}

/** A verified receiver claim: the transfer is locked to this peer. */
interface VerifiedClaim {
  receiverPubkey: string;
  receiverEcdhPublicKey: Uint8Array;
  payload: ClaimPayload;
  authKey: CryptoKey;
}

function decodeEcdhPublicKey(b64: string): Uint8Array | null {
  try {
    const bytes = base64ToUint8Array(b64);
    if (bytes.length !== 65 || bytes[0] !== 0x04) return null;
    return bytes;
  } catch {
    return null;
  }
}

export interface UseNostrSendReturn {
  state: TransferState;
  pin: string | null;
  /** Fingerprint of the currently displayed PIN, formatted for display. */
  pinFingerprint: string | null;
  send: (content: File) => Promise<void>;
  cancel: () => void;
}

export function useNostrSend(): UseNostrSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [pin, setPin] = useState<string | null>(null);
  const [pinFingerprint, setPinFingerprint] = useState<string | null>(null);

  const clientRef = useRef<NostrClient | null>(null);
  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    setPin(null);
    setPinFingerprint(null);
    setState({ status: 'idle' });
  }, []);

  const send = useCallback(async (content: File) => {
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

      // Per-transfer credentials: public salt (HKDF input for the ECDH session
      // keys), ephemeral Nostr identity, and the ephemeral ECDH key pair whose
      // shared secret will protect signaling and content.
      const salt = generateSalt();
      const { secretKey, publicKey } = generateEphemeralKeys();
      const transferId = generateTransferId();

      setState({ status: 'connecting', message: 'Preparing secure keys...' });
      const ecdh = await generateECDHKeyPair();
      const ecdhPublicKeyB64 = uint8ArrayToBase64(ecdh.publicKeyBytes);

      if (cancelledRef.current) return;

      // Create Nostr client for signaling
      setState({ status: 'connecting', message: 'Connecting to relays...' });
      const client = createNostrClient([...DEFAULT_RELAYS]);
      clientRef.current = client;
      await client.waitForConnection();

      if (cancelledRef.current) return;

      setState({
        status: 'waiting_for_receiver',
        message: 'Waiting for receiver...',
        contentType,
        fileMetadata: { fileName, fileSize, mimeType },
        useWebRTC: true,
        currentRelays: client.getRelays(),
        totalRelays: DEFAULT_RELAYS.length,
      });

      // Rotate the PIN until a receiver proves knowledge of one of the
      // retained generations, then lock the transfer to that receiver.
      const generations: PinGeneration[] = [];

      const publishRendezvous = async () => {
        const newPin = generatePin();
        const root = await importPinRoot(newPin);
        const [hint, authKey, rendezvousKey, fingerprint] = await Promise.all([
          computePinHintFromRoot(root),
          derivePinAuthKey(root),
          derivePinRendezvousKey(root),
          computePinFingerprintFromRoot(root),
        ]);
        const nonce = generateHandshakeNonce();

        const payload: RendezvousPayload = {
          type: 'rendezvous',
          contentType,
          transferId,
          senderPubkey: publicKey,
          ecdhPublicKey: ecdhPublicKeyB64,
          nonce,
          relays: [...DEFAULT_RELAYS],
          fileName,
          fileSize,
          mimeType,
        };
        const encryptedPayload = await encrypt(
          rendezvousKey,
          new TextEncoder().encode(JSON.stringify(payload)),
        );
        const event = createRendezvousEvent(
          secretKey,
          encryptedPayload,
          salt,
          transferId,
          hint,
        );

        if (cancelledRef.current) return;

        // Register the generation before publishing so a fast claim can never
        // race ahead of the retained-keys list.
        generations.unshift({ authKey, nonce });
        if (generations.length > PIN_ACTIVE_GENERATIONS) {
          generations.length = PIN_ACTIVE_GENERATIONS;
        }

        await client.publish(event);

        if (!cancelledRef.current) {
          setPin(newPin);
          setPinFingerprint(formatPinHint(fingerprint));
        }
      };

      const claim = await new Promise<VerifiedClaim>((resolve, reject) => {
        let settled = false;
        let rotationInterval: ReturnType<typeof setInterval> | null = null;
        let cancelPoll: ReturnType<typeof setInterval> | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let subId: string | null = null;

        const cleanup = () => {
          if (rotationInterval) clearInterval(rotationInterval);
          if (cancelPoll) clearInterval(cancelPoll);
          if (timeout) clearTimeout(timeout);
          if (subId) client.unsubscribe(subId);
          rotationInterval = null;
          cancelPoll = null;
          timeout = null;
          subId = null;
        };

        timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error('No receiver connected. Please start a new transfer.'),
          );
        }, PIN_DISPLAY_TIMEOUT_MS);

        cancelPoll = setInterval(() => {
          if (cancelledRef.current && !settled) {
            settled = true;
            cleanup();
            reject(new Error('Cancelled'));
          }
        }, 250);

        const processedEventIds = new Set<string>();

        subId = client.subscribe(
          [
            {
              kinds: [EVENT_KIND_DATA_TRANSFER],
              '#t': [transferId],
              '#p': [publicKey],
            },
          ],
          (event: Event) => {
            if (settled || cancelledRef.current) return;
            if (processedEventIds.has(event.id)) return;
            processedEventIds.add(event.id);

            const handshake = parseHandshakeEvent(event);
            if (
              !handshake ||
              handshake.type !== 'claim' ||
              handshake.transferId !== transferId
            ) {
              return;
            }

            void (async () => {
              // Try every retained PIN generation; a claim sealed with a
              // rotated-but-still-honored PIN must not be rejected.
              for (const generation of [...generations]) {
                let opened: unknown;
                try {
                  opened = await openHandshakePayload(
                    generation.authKey,
                    handshake.sealedPayload,
                  );
                } catch {
                  continue; // Sealed with a different PIN/generation
                }

                const p = opened as Partial<ClaimPayload>;
                const receiverEcdhPublicKey =
                  typeof p.receiverEcdhPublicKey === 'string'
                    ? decodeEcdhPublicKey(p.receiverEcdhPublicKey)
                    : null;

                // Invalid claims are ignored, never fatal: transfer tags are
                // public, so aborting here would let anyone deny the transfer.
                if (
                  p.type !== 'claim' ||
                  p.transferId !== transferId ||
                  p.senderNonce !== generation.nonce ||
                  typeof p.receiverNonce !== 'string' ||
                  !p.receiverNonce ||
                  p.senderEcdhPublicKey !== ecdhPublicKeyB64 ||
                  !receiverEcdhPublicKey
                ) {
                  return;
                }

                if (settled) return;
                settled = true;
                cleanup();
                resolve({
                  receiverPubkey: event.pubkey,
                  receiverEcdhPublicKey,
                  payload: p as ClaimPayload,
                  authKey: generation.authKey,
                });
                return;
              }
            })();
          },
        );

        // First PIN generation, then rotate.
        void publishRendezvous().catch((err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error('Publish failed'));
        });
        rotationInterval = setInterval(() => {
          if (settled || cancelledRef.current) return;
          void publishRendezvous().catch((err) => {
            console.error('Failed to publish rendezvous rotation:', err);
          });
        }, PIN_ROTATION_MS);
      });

      if (cancelledRef.current) return;

      // First-claim lockout: rotation has stopped, retained generations are
      // dropped with this scope, and only this receiver's events are processed
      // from here on. The PIN is no longer needed for display.
      setPin(null);
      setPinFingerprint(null);

      // Mutual proof: confirm under the same PIN-derived auth key that sealed
      // the claim, echoing both nonces and the receiver key we locked onto.
      const confirmPayload: ConfirmPayload = {
        type: 'confirm',
        transferId,
        senderNonce: claim.payload.senderNonce,
        receiverNonce: claim.payload.receiverNonce,
        receiverEcdhPublicKey: claim.payload.receiverEcdhPublicKey,
      };
      const confirmEvent = createHandshakeEvent(
        secretKey,
        claim.receiverPubkey,
        transferId,
        'confirm',
        await sealHandshakePayload(claim.authKey, confirmPayload),
      );
      await client.publish(confirmEvent);

      // Session keys come from the ephemeral ECDH exchange the PIN just
      // authenticated — the PIN derives no content or signaling keys.
      const sharedSecret = await deriveSharedSecretKey(
        ecdh.privateKey,
        claim.receiverEcdhPublicKey,
      );
      const sessionKeys: NostrSessionKeys = await deriveNostrSessionKeys(
        sharedSecret,
        salt,
      );

      if (cancelledRef.current) return;

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
          let offerRetryInterval: ReturnType<typeof setInterval> | null = null;
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
                  sessionKeys.signals,
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
                sessionKeys.signals,
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
                  sessionKeys.content,
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
                authors: [claim.receiverPubkey],
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
                  authors: [claim.receiverPubkey],
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
            console.log(`Retrying WebRTC offer (attempt ${retryCount + 1})...`);
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
        setPinFingerprint(null);
        setState((prevState) => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to send',
          connectionFailed: error instanceof P2PConnectionError,
        }));
      }
    } finally {
      sendingRef.current = false;
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
    }
  }, []);

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, pin, pinFingerprint, send, cancel }),
    [state, pin, pinFingerprint, send, cancel],
  );
}
