import { useState, useCallback, useRef } from 'react'
import {
  deriveNostrTransferKeysFromPinKey,
  computePinHintFromKey,
  decrypt,
  encrypt,
  parseChunkMessage,
  decryptChunk,
  MAX_MESSAGE_SIZE,
  ENCRYPTION_CHUNK_SIZE,
  CLOUD_CHUNK_SIZE,
  TRANSFER_EXPIRATION_MS,
  AES_NONCE_LENGTH,
  AES_TAG_LENGTH,
  type NostrTransferKeys,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  parsePinExchangeEvent,
  createAuthenticatedAckEvent,
  parseChunkNotifyEvent,
  DEFAULT_RELAYS,
  type TransferState,
  type PinExchangePayload,
  type ChunkNotifyPayload,
  type NostrClient,
  EVENT_KIND_PIN_EXCHANGE,
  EVENT_KIND_DATA_TRANSFER,
  createSignalingEvent,
  parseSignalingEvent,
} from '@/lib/nostr'
import type { PinKeyMaterial, ReceivedContent } from '@/lib/types'
import { downloadFromCloud } from '@/lib/cloud-storage'
import type { Event } from 'nostr-tools'
import { WebRTCConnection } from '@/lib/webrtc'
import { getWebRTCConfig } from '@/lib/webrtc-config'

export interface UseNostrReceiveReturn {
  state: TransferState
  receivedContent: ReceivedContent | null
  receive: (pinMaterial: PinKeyMaterial) => Promise<void>
  cancel: () => void
  reset: () => void
}

export function useNostrReceive(): UseNostrReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' })
  const [receivedContent, setReceivedContent] = useState<ReceivedContent | null>(null)

  const clientRef = useRef<NostrClient | null>(null)
  const cancelledRef = useRef(false)
  const receivingRef = useRef(false)

  const cancel = useCallback(() => {
    cancelledRef.current = true
    receivingRef.current = false
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
    }
    setState({ status: 'idle' })
  }, [])

  const reset = useCallback(() => {
    cancel()
    setReceivedContent(null)
  }, [cancel])

  const receive = useCallback(async (pinMaterial: PinKeyMaterial) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return
    receivingRef.current = true
    cancelledRef.current = false
    setReceivedContent(null)

    try {
      let keys: NostrTransferKeys | null = null

      // PIN mode: use provided material
      if (!pinMaterial.key || !pinMaterial.fingerprint) {
        setState({ status: 'error', message: 'PIN unavailable. Please re-enter.' })
        receivingRef.current = false
        return
      }
      setState({ status: 'connecting', message: 'Deriving encryption keys...' })

      // The PIN hint is salted with the current time bucket, so the sender's hint is
      // tied to the bucket it published in. Derive both the current and previous bucket
      // hints and query for either, so a transfer created just before a bucket rollover
      // is still found (one look-back covers the whole non-expired window, since the
      // bucket width equals the transfer lifetime). Mirrors the QR signaling parser,
      // which de-obfuscates against the current and previous time bucket.
      const [hintCurrent, hintPrev] = await Promise.all([
        computePinHintFromKey(pinMaterial.key, 0),
        computePinHintFromKey(pinMaterial.key, 1),
      ])

      if (cancelledRef.current) return

      // Connect to relays
      setState({ status: 'connecting', message: 'Connecting to relays...' })
      const client = createNostrClient([...DEFAULT_RELAYS])
      clientRef.current = client

      if (cancelledRef.current) return

      // Search for exchange event
      setState({ status: 'receiving', message: 'Searching for sender...' })

      // Query for events matching the current or previous time-bucket hint
      const events = await client.query([
        {
          kinds: [EVENT_KIND_PIN_EXCHANGE],
          '#h': [hintCurrent, hintPrev],
          limit: 10,
        },
      ])

      if (cancelledRef.current) return

      if (events.length === 0) {
        setState({
          status: 'error',
          message: 'No transfer found for this PIN',
        })
        return
      }

      // Try to decrypt each event
      let payload: PinExchangePayload | null = null
      let transferId: string | null = null
      let senderPubkey: string | null = null
      let sawExpiredCandidate = false
      let sawNonExpiredCandidate = false
      let selectedCreatedAtSec: number | null = null
      let matchedHint: string = hintCurrent

      const sortedEvents = [...events].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))

      for (const event of sortedEvents) {
        // Enforce TTL
        if (!event.created_at) {
          sawExpiredCandidate = true
          continue
        }
        const eventAgeMs = Date.now() - event.created_at * 1000
        if (eventAgeMs > TRANSFER_EXPIRATION_MS) {
          sawExpiredCandidate = true
          continue
        }
        sawNonExpiredCandidate = true

        // PIN mode
        const parsed = parsePinExchangeEvent(event)
        if (!parsed) continue

        try {
          const derivedKeys = await deriveNostrTransferKeysFromPinKey(pinMaterial.key, parsed.salt)
          const decrypted = await decrypt(derivedKeys.metadata, parsed.encryptedPayload)
          const decoder = new TextDecoder()
          const payloadStr = decoder.decode(decrypted)
          payload = JSON.parse(payloadStr) as PinExchangePayload

          transferId = parsed.transferId
          senderPubkey = event.pubkey
          keys = derivedKeys
          selectedCreatedAtSec = event.created_at || null
          // Echo back the exact hint the sender published (current or previous bucket)
          matchedHint = parsed.hint
          break
        } catch {
          // Silently ignore decryption failures and continue trying other candidates.
          // A failure here just means this event wasn't encrypted with our PIN key
          // (wrong/stale event sharing the same hint), not a real error.
        }
      }

      if (!payload || !keys) {
        if (!sawNonExpiredCandidate && sawExpiredCandidate) {
          setState({ status: 'error', message: 'Transfer expired. Ask sender to start a new transfer.' })
          return
        }
        setState({
          status: 'error',
          message: 'Could not decrypt transfer. Wrong PIN?',
        })
        return
      }

      if (!transferId || !senderPubkey) {
        if (!sawNonExpiredCandidate && sawExpiredCandidate) {
          setState({ status: 'error', message: 'Transfer expired. Ask sender to start a new transfer.' })
          return
        }
        setState({
          status: 'error',
          message: 'Could not decrypt transfer. Wrong PIN?',
        })
        return
      }

      if (!selectedCreatedAtSec || Date.now() - selectedCreatedAtSec * 1000 > TRANSFER_EXPIRATION_MS) {
        setState({ status: 'error', message: 'Transfer expired. Ask sender to generate a new PIN.' })
        return
      }

      if (cancelledRef.current) return

      // Validate payload
      if (payload.fileSize == null || !Number.isFinite(payload.fileSize) || payload.fileSize < 0) {
        setState({ status: 'error', message: 'Invalid file size in transfer' })
        return
      }

      const resolvedFileName = payload.fileName || 'unknown'
      const resolvedFileSize = payload.fileSize
      const resolvedMimeType = payload.mimeType || 'application/octet-stream'
      const expectedEncryptedCloudSize = resolvedFileSize + AES_NONCE_LENGTH + AES_TAG_LENGTH
      const expectedCloudChunks = Math.max(1, Math.ceil(expectedEncryptedCloudSize / CLOUD_CHUNK_SIZE))

      if (resolvedFileSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(resolvedFileSize / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`,
        })
        return
      }

      if (
        !Number.isInteger(payload.totalChunks) ||
        payload.totalChunks !== expectedCloudChunks
      ) {
        setState({ status: 'error', message: 'Invalid cloud transfer metadata' })
        return
      }

      // Generate receiver keypair only after the decrypted metadata is accepted.
      const { secretKey } = generateEphemeralKeys()

      // Send ready ACK (seq=0), authenticated with the PIN-derived signals key.
      const readyAck = await createAuthenticatedAckEvent(secretKey, senderPubkey, transferId, 0, keys.signals, matchedHint)
      await client.publish(readyAck)

      if (cancelledRef.current) return

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
      })

      // Unified listener for P2P and cloud transfer
      let webRTCSuccess = false
      const receivedCloudChunkIndices: Set<number> = new Set()
      const pendingCloudChunkIndices: Set<number> = new Set()
      let cloudBuffer: Uint8Array | null = null
      let cloudTotalBytes = 0
      const expectedTotalChunks = expectedCloudChunks

      const transferResult = await new Promise<{ mode: 'p2p' | 'cloud' | 'inline'; data: Uint8Array }>(
        (resolve, reject) => {
          let rtc: WebRTCConnection | null = null
          const expectedSize = resolvedFileSize
          let combinedBuffer: Uint8Array | null = expectedSize > 0 ? new Uint8Array(expectedSize) : null
          const receivedChunkIndices: Set<number> = new Set()
          const pendingChunkPromises: Set<Promise<void>> = new Set()
          const expectedP2PChunks = Math.ceil(resolvedFileSize / ENCRYPTION_CHUNK_SIZE)
          let totalDecryptedBytes = 0
          let settled = false
          let cloudTransferStarted = false

          const overallTimeout = setTimeout(() => {
            if (!settled) {
              settled = true
              if (rtc) rtc.close()
              client.unsubscribe(subId)
              reject(new Error('Transfer timeout'))
            }
          }, 10 * 60 * 1000)

          const initWebRTC = () => {
            if (rtc) return rtc

            rtc = new WebRTCConnection(
              getWebRTCConfig(),
              async (signal) => {
                const signalPayload = { type: 'signal', signal }
                const signalJson = JSON.stringify(signalPayload)
                const encryptedSignal = await encrypt(keys!.signals, new TextEncoder().encode(signalJson))
                const event = createSignalingEvent(secretKey, senderPubkey!, transferId!, encryptedSignal)
                await client.publish(event)
              },
              () => {
                setState((s) => ({ ...s, message: 'Receiving via P2P...', useWebRTC: true }))
              },
              (data) => {
                if (typeof data === 'string' && data.startsWith('DONE:')) {
                  void (async () => {
                    const expectedChunks = parseInt(data.split(':')[1], 10)
                    if (!Number.isInteger(expectedChunks) || expectedChunks <= 0) {
                      reject(new Error('Invalid DONE message: missing chunk count'))
                      return
                    }
                    if (expectedChunks !== expectedP2PChunks) {
                      reject(
                        new Error(`Invalid DONE message: expected ${expectedP2PChunks} chunks, got ${expectedChunks}`)
                      )
                      return
                    }

                    if (pendingChunkPromises.size > 0) {
                      await Promise.allSettled(Array.from(pendingChunkPromises))
                    }

                    if (receivedChunkIndices.size !== expectedChunks) {
                      reject(
                        new Error(`Missing chunks: got ${receivedChunkIndices.size}, expected ${expectedChunks}`)
                      )
                      return
                    }
                    if (totalDecryptedBytes !== resolvedFileSize) {
                      reject(
                        new Error(`Incomplete transfer: got ${totalDecryptedBytes} bytes, expected ${resolvedFileSize}`)
                      )
                      return
                    }

                    if (!settled) {
                      settled = true
                      clearTimeout(overallTimeout)
                      client.unsubscribe(subId)
                      if (rtc) {
                        rtc.send('DONE_ACK')
                        rtc.close()
                      }

                      const result = combinedBuffer
                        ? combinedBuffer.slice(0, totalDecryptedBytes)
                        : new Uint8Array(0)

                      webRTCSuccess = true
                      resolve({ mode: 'p2p', data: result })
                    }
                  })()
                  return
                }

                if (typeof data === 'string' && data === 'DONE') {
                  reject(new Error('Unsupported sender: missing chunk count. Ask sender to update and retry.'))
                  return
                }

                if (data instanceof ArrayBuffer) {
                  if (settled) return
                  const decryptPromise = (async () => {
                    try {
                      const { chunkIndex, encryptedData } = parseChunkMessage(data)
                      if (receivedChunkIndices.has(chunkIndex)) {
                        throw new Error(`Duplicate chunk index: ${chunkIndex}`)
                      }
                      if (chunkIndex >= expectedP2PChunks) {
                        throw new Error(`Chunk index out of range: ${chunkIndex}`)
                      }

                      const expectedPlaintextLength =
                        chunkIndex === expectedP2PChunks - 1
                          ? resolvedFileSize - chunkIndex * ENCRYPTION_CHUNK_SIZE
                          : ENCRYPTION_CHUNK_SIZE
                      const expectedEncryptedLength = expectedPlaintextLength + AES_NONCE_LENGTH + AES_TAG_LENGTH
                      if (encryptedData.length !== expectedEncryptedLength) {
                        throw new Error(
                          `Invalid encrypted chunk ${chunkIndex} length: expected ${expectedEncryptedLength}, got ${encryptedData.length}`
                        )
                      }

                      const decryptedChunk = await decryptChunk(keys!.p2pContent, encryptedData, chunkIndex)
                      const writePosition = chunkIndex * ENCRYPTION_CHUNK_SIZE
                      const requiredSize = writePosition + decryptedChunk.length
                      const expectedChunkLength =
                        chunkIndex === expectedP2PChunks - 1
                          ? resolvedFileSize - writePosition
                          : ENCRYPTION_CHUNK_SIZE

                      if (decryptedChunk.length !== expectedChunkLength) {
                        throw new Error(
                          `Invalid chunk ${chunkIndex} length: expected ${expectedChunkLength}, got ${decryptedChunk.length}`
                        )
                      }
                      if (requiredSize > resolvedFileSize) {
                        throw new Error(`Chunk ${chunkIndex} exceeds expected file size`)
                      }

                      if (!combinedBuffer || combinedBuffer.length < requiredSize) {
                        const newBuffer = new Uint8Array(
                          Math.max(requiredSize, (combinedBuffer?.length || 0) * 2)
                        )
                        if (combinedBuffer) {
                          newBuffer.set(combinedBuffer)
                        }
                        combinedBuffer = newBuffer
                      }

                      combinedBuffer.set(decryptedChunk, writePosition)
                      receivedChunkIndices.add(chunkIndex)
                      totalDecryptedBytes += decryptedChunk.length

                      setState((s) => ({
                        ...s,
                        status: 'receiving',
                        progress: {
                          current: totalDecryptedBytes,
                          total: resolvedFileSize,
                        },
                      }))
                    } catch (err) {
                      console.error('Failed to decrypt chunk:', err)
                    }
                  })()
                  pendingChunkPromises.add(decryptPromise)
                  void decryptPromise.finally(() => {
                    pendingChunkPromises.delete(decryptPromise)
                  })
                }
              }
            )
            return rtc
          }

          const handleChunkNotify = async (chunkPayload: ChunkNotifyPayload) => {
            if (settled) return
            if (pendingCloudChunkIndices.has(chunkPayload.chunkIndex)) return

            if (!isValidCloudChunkNotify(chunkPayload, transferId!, expectedTotalChunks, expectedEncryptedCloudSize)) {
              settled = true
              if (rtc) {
                rtc.close()
                rtc = null
              }
              client.unsubscribe(subId)
              reject(new Error('Invalid cloud chunk notification'))
              return
            }

            pendingCloudChunkIndices.add(chunkPayload.chunkIndex)

            if (!cloudTransferStarted) {
              cloudTransferStarted = true
              if (rtc) {
                rtc.close()
                rtc = null
              }
              cloudBuffer = new Uint8Array(expectedEncryptedCloudSize)
            }

            setState((s) => ({
              ...s,
              message: `Downloading chunk ${chunkPayload.chunkIndex + 1}/${chunkPayload.totalChunks}...`,
              useWebRTC: false,
            }))

            try {
              const chunkData = await downloadFromCloud(chunkPayload.chunkUrl, (loaded) => {
                setState((s) => ({
                  ...s,
                  progress: {
                    current: cloudTotalBytes + loaded,
                    total: resolvedFileSize,
                  },
                }))
              })

              if (chunkData.length !== chunkPayload.chunkSize) {
                throw new Error(
                  `Invalid cloud chunk ${chunkPayload.chunkIndex} size: expected ${chunkPayload.chunkSize}, got ${chunkData.length}`
                )
              }

              const writePosition = chunkPayload.chunkIndex * CLOUD_CHUNK_SIZE
              const requiredSize = writePosition + chunkData.length

              if (!cloudBuffer || requiredSize > expectedEncryptedCloudSize) {
                throw new Error(`Cloud chunk ${chunkPayload.chunkIndex} exceeds expected encrypted size`)
              }

              cloudBuffer.set(chunkData, writePosition)
              receivedCloudChunkIndices.add(chunkPayload.chunkIndex)
              cloudTotalBytes += chunkData.length

              const chunkAck = await createAuthenticatedAckEvent(
                secretKey,
                senderPubkey!,
                transferId!,
                chunkPayload.chunkIndex + 1,
                keys!.signals
              )
              await client.publish(chunkAck)

              if (receivedCloudChunkIndices.size === expectedTotalChunks) {
                settled = true
                clearTimeout(overallTimeout)
                client.unsubscribe(subId)
                if (cloudTotalBytes !== expectedEncryptedCloudSize) {
                  reject(
                    new Error(
                      `Incomplete cloud transfer: got ${cloudTotalBytes} bytes, expected ${expectedEncryptedCloudSize}`
                    )
                  )
                  return
                }
                const result = cloudBuffer.slice(0, cloudTotalBytes)
                resolve({ mode: 'cloud', data: result })
              }
            } catch (err) {
              console.error(`Failed to download chunk ${chunkPayload.chunkIndex}:`, err)
            } finally {
              pendingCloudChunkIndices.delete(chunkPayload.chunkIndex)
            }
          }

          const processedEventIds = new Set<string>()

          const processEvent = async (event: Event) => {
            if (settled) return
            if (processedEventIds.has(event.id)) return
            processedEventIds.add(event.id)

            if (!cloudTransferStarted) {
              const signalData = parseSignalingEvent(event)
              if (signalData && signalData.transferId === transferId) {
                try {
                  const decrypted = await decrypt(keys!.signals, signalData.encryptedSignal)
                  const signalPayload = JSON.parse(new TextDecoder().decode(decrypted))
                  if (signalPayload.type === 'signal' && signalPayload.signal) {
                    const r = initWebRTC()
                    await r.handleSignal(signalPayload.signal)
                  }
                } catch (e) {
                  console.error('Signal handling error', e)
                }
                return
              }
            }

            const chunkNotify = parseChunkNotifyEvent(event)
            if (chunkNotify && chunkNotify.transferId === transferId) {
              if (!receivedCloudChunkIndices.has(chunkNotify.chunkIndex)) {
                await handleChunkNotify(chunkNotify)
              }
            }
          }

          const subId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId!],
                authors: [senderPubkey!],
              },
            ],
            processEvent
          )

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
              ])
              for (const event of existingEvents) {
                await processEvent(event)
              }
            } catch (err) {
              console.error('Failed to query existing events:', err)
            }
          })()
        }
      )

      if (cancelledRef.current) return

      // Process received data
      let contentData: Uint8Array

      if (transferResult.mode === 'p2p') {
        contentData = transferResult.data
        webRTCSuccess = true
      } else {
        setState((s) => ({ ...s, message: 'Decrypting...' }))
        if (!keys) {
          throw new Error('Session keys not available for decryption')
        }
        contentData = await decrypt(keys.cloudContent, transferResult.data)
      }

      if (cancelledRef.current) return

      // Send completion ACK
      const completeAck = await createAuthenticatedAckEvent(secretKey, senderPubkey, transferId, -1, keys.signals)
      await client.publish(completeAck)

      // Set received content
      setReceivedContent({
        contentType: 'file',
        data: contentData,
        fileName: resolvedFileName,
        fileSize: resolvedFileSize,
        mimeType: resolvedMimeType,
      })

      setState((prevState) => ({
        status: 'complete',
        message: webRTCSuccess ? 'File received (P2P)!' : 'File received!',
        contentType: 'file',
        fileMetadata: {
          fileName: resolvedFileName,
          fileSize: resolvedFileSize,
          mimeType: resolvedMimeType,
        },
        currentRelays: prevState.currentRelays,
        totalRelays: prevState.totalRelays,
        useWebRTC: prevState.useWebRTC,
      }))
    } catch (error) {
      if (!cancelledRef.current) {
        setState((prevState) => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
        }))
      }
    } finally {
      receivingRef.current = false
      if (clientRef.current) {
        clientRef.current.close()
        clientRef.current = null
      }
    }
  }, [])

  return { state, receivedContent, receive, cancel, reset }
}

function isValidCloudChunkNotify(
  payload: ChunkNotifyPayload,
  transferId: string,
  expectedTotalChunks: number,
  expectedEncryptedSize: number
): boolean {
  if (payload.transferId !== transferId) return false
  if (!Number.isInteger(payload.chunkIndex) || payload.chunkIndex < 0) return false
  if (!Number.isInteger(payload.totalChunks) || payload.totalChunks !== expectedTotalChunks) return false
  if (payload.chunkIndex >= expectedTotalChunks) return false
  if (!Number.isInteger(payload.chunkSize) || payload.chunkSize <= 0) return false
  if (payload.chunkSize > CLOUD_CHUNK_SIZE) return false

  const expectedChunkSize =
    payload.chunkIndex === expectedTotalChunks - 1
      ? expectedEncryptedSize - payload.chunkIndex * CLOUD_CHUNK_SIZE
      : CLOUD_CHUNK_SIZE

  return payload.chunkSize === expectedChunkSize
}
