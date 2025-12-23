import { useState, useCallback, useRef } from 'react'
import {
  deriveKeyFromPinKey,
  decrypt,
  encrypt,
  parseChunkMessage,
  decryptChunk,
  MAX_MESSAGE_SIZE,
  ENCRYPTION_CHUNK_SIZE,
  CLOUD_CHUNK_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  parsePinExchangeEvent,
  createAckEvent,
  discoverBackupRelays,
  parseChunkNotifyEvent,
  DEFAULT_RELAYS,
  type TransferState,
  type PinExchangePayload,
  type ChunkNotifyPayload,
  EVENT_KIND_PIN_EXCHANGE,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
  createSignalingEvent,
  parseSignalingEvent,
} from '@/lib/nostr'
import type { PinKeyMaterial, ReceivedContent } from '@/lib/types'
import { downloadFromCloud } from '@/lib/cloud-storage'
import type { Event } from 'nostr-tools'
import { WebRTCConnection } from '@/lib/webrtc'

/**
 * Publish with backup relay fallback.
 * If primary publish fails, discovers backup relays and retries.
 */
async function publishWithBackup(
  client: NostrClient,
  event: Event,
  maxRetries: number = 3
): Promise<void> {
  try {
    await client.publish(event, maxRetries)
  } catch (err) {
    // Primary relays failed, try to discover backup relays
    console.log('Primary relays failed, discovering backup relays...')
    const currentRelays = client.getRelays()
    const backupRelays = await discoverBackupRelays(currentRelays, 5)

    if (backupRelays.length === 0) {
      throw err // No backup relays found, propagate original error
    }

    // Add backup relays and retry
    await client.addRelays(backupRelays)
    await client.publish(event, maxRetries)
  }
}

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
      if (!pinMaterial?.key || !pinMaterial?.hint) {
        setState({ status: 'error', message: 'PIN unavailable. Please re-enter.' })
        return
      }

      // Derive key from PIN
      setState({ status: 'connecting', message: 'Deriving encryption key...' })
      const pinHint = pinMaterial.hint

      if (cancelledRef.current) return

      // Use seed relays for PIN exchange query
      setState({ status: 'connecting', message: 'Connecting to relays...' })
      const client = createNostrClient([...DEFAULT_RELAYS])
      clientRef.current = client

      if (cancelledRef.current) return

      // Search for PIN exchange event
      setState({ status: 'receiving', message: 'Searching for sender...' })

      // Query for PIN exchange events with matching hint
      const events = await client.query([
        {
          kinds: [EVENT_KIND_PIN_EXCHANGE],
          '#h': [pinHint],
          limit: 10,
        },
      ])

      if (cancelledRef.current) return

      if (events.length === 0) {
        setState({ status: 'error', message: 'No transfer found for this PIN' })
        return
      }

      // Try to decrypt each event (in case of hint collision)
      let payload: PinExchangePayload | null = null
      let transferId: string | null = null
      let senderPubkey: string | null = null
      let key: CryptoKey | null = null
      let sawExpiredCandidate = false
      let sawNonExpiredCandidate = false
      let selectedCreatedAtSec: number | null = null

      // Prefer newest non-expired events first.
      const sortedEvents = [...events].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))

      for (const event of sortedEvents) {
        // Enforce TTL before establishing any session, even if PIN is correct.
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

        const parsed = parsePinExchangeEvent(event)
        if (!parsed) continue

        try {
          // Derive key with this salt
          const derivedKey = await deriveKeyFromPinKey(pinMaterial.key, parsed.salt)

          // Try to decrypt
          const decrypted = await decrypt(derivedKey, parsed.encryptedPayload)
          const decoder = new TextDecoder()
          const payloadStr = decoder.decode(decrypted)
          payload = JSON.parse(payloadStr) as PinExchangePayload

          transferId = parsed.transferId
          senderPubkey = event.pubkey
          key = derivedKey
          selectedCreatedAtSec = event.created_at || null
          break
        } catch {
          // Decryption failed, try next event
          continue
        }
      }

      if (!payload || !transferId || !senderPubkey || !key) {
        if (!sawNonExpiredCandidate && sawExpiredCandidate) {
          setState({ status: 'error', message: 'Transfer expired. Ask sender to generate a new PIN.' })
          return
        }
        setState({ status: 'error', message: 'Could not decrypt transfer. Wrong PIN?' })
        return
      }

      if (!selectedCreatedAtSec || Date.now() - selectedCreatedAtSec * 1000 > TRANSFER_EXPIRATION_MS) {
        setState({ status: 'error', message: 'Transfer expired. Ask sender to generate a new PIN.' })
        return
      }

      // Required field: fileSize must be present and valid
      if (payload.fileSize == null || !Number.isFinite(payload.fileSize) || payload.fileSize < 0) {
        setState({ status: 'error', message: 'Invalid file size in transfer' })
        return
      }

      const resolvedFileName = payload.fileName || 'unknown'
      const resolvedFileSize = payload.fileSize
      const resolvedMimeType = payload.mimeType || 'application/octet-stream'

      // Security check: Enforce MAX_MESSAGE_SIZE to prevent DoS/OOM
      const expectedSize = resolvedFileSize
      if (expectedSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(expectedSize / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`
        })
        return
      }

      if (cancelledRef.current) return

      // Generate receiver keypair
      const { secretKey } = generateEphemeralKeys()

      // Send ready ACK (seq=0)
      console.log(`Sending ready ACK (seq=0) for transfer ${transferId}`)
      const readyAck = createAckEvent(secretKey, senderPubkey, transferId, 0)
      await publishWithBackup(client, readyAck)
      console.log(`✓ Ready ACK sent successfully`)

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
      })

      // Unified listener for both P2P and chunked cloud transfer
      // P2P is preferred, but if sender can't establish P2P, they'll send chunk notifications
      let webRTCSuccess = false
      // Cloud uses separate tracking since encrypted chunks have different size
      const receivedCloudChunkIndices: Set<number> = new Set()
      let cloudBuffer: Uint8Array | null = null
      let cloudTotalBytes = 0
      let expectedTotalChunks = payload.totalChunks || 1

      const transferResult = await new Promise<{ mode: 'p2p' | 'cloud' | 'inline'; data: Uint8Array }>((resolve, reject) => {
        let rtc: WebRTCConnection | null = null

        // Pre-allocate buffer for received data to avoid 2x memory during assembly
        // For files, use fileSize; for text, we'll grow as needed
        const expectedSize = resolvedFileSize
        let combinedBuffer: Uint8Array | null = expectedSize > 0 ? new Uint8Array(expectedSize) : null
        const receivedChunkIndices: Set<number> = new Set()
        const pendingChunkPromises: Set<Promise<void>> = new Set()
        let totalDecryptedBytes = 0
        let settled = false
        let cloudTransferStarted = false

        // Overall timeout - 10 minutes for entire transfer
        const overallTimeout = setTimeout(() => {
          if (!settled) {
            settled = true
            if (rtc) rtc.close()
            client.unsubscribe(subId)
            reject(new Error('Transfer timeout'))
          }
        }, 10 * 60 * 1000)

        // Initialize WebRTC on first signal offer
        const initWebRTC = () => {
          if (rtc) return rtc

          rtc = new WebRTCConnection(
            { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
            async (signal) => {
              // Send Answer/Candidate via Nostr
              const signalPayload = { type: 'signal', signal }
              const signalJson = JSON.stringify(signalPayload)
              const encryptedSignal = await encrypt(key!, new TextEncoder().encode(signalJson))
              const event = createSignalingEvent(secretKey, senderPubkey!, transferId!, encryptedSignal)
              await client.publish(event)
            },
            () => {
              console.log('Receiver DataChannel open')
              setState(s => ({ ...s, message: 'Receiving via P2P...', useWebRTC: true }))
            },
            (data) => {
              // Handle DONE message with chunk count (format: "DONE:N")
              if (typeof data === 'string' && data.startsWith('DONE:')) {
                void (async () => {
                  const expectedChunks = parseInt(data.split(':')[1], 10)
                  if (!Number.isFinite(expectedChunks)) {
                    reject(new Error('Invalid DONE message: missing chunk count'))
                    return
                  }

                  // Wait for any in-flight chunk decrypts to complete before verifying.
                  if (pendingChunkPromises.size > 0) {
                    await Promise.allSettled(Array.from(pendingChunkPromises))
                  }

                  // Verify all chunks received
                  if (receivedChunkIndices.size !== expectedChunks) {
                    console.error(`Chunk count mismatch: got ${receivedChunkIndices.size}, expected ${expectedChunks}`)
                    reject(new Error(`Missing chunks: got ${receivedChunkIndices.size}, expected ${expectedChunks}`))
                    return
                  }

                  // Transfer complete via WebRTC
                  if (!settled) {
                    settled = true
                    clearTimeout(overallTimeout)
                    client.unsubscribe(subId)
                    if (rtc) {
                      rtc.send('DONE_ACK')
                      rtc.close()
                    }

                    // Buffer is already assembled - just trim to actual size if needed
                    const result = combinedBuffer
                      ? combinedBuffer.slice(0, totalDecryptedBytes)
                      : new Uint8Array(0)

                    console.log(`P2P transfer complete: received and decrypted ${expectedChunks} chunks (${totalDecryptedBytes} bytes)`)
                    webRTCSuccess = true
                    resolve({ mode: 'p2p', data: result })
                  }
                })()
                return
              }

              // Handle legacy DONE format (for backwards compatibility)
              if (typeof data === 'string' && data === 'DONE') {
                reject(new Error('Unsupported sender: missing chunk count. Ask sender to update and retry.'))
                return
              }

              // Handle encrypted chunk data
              if (data instanceof ArrayBuffer) {
                if (settled) return
                // Parse and decrypt chunk on-the-fly, write directly to buffer
                const decryptPromise = (async () => {
                  try {
                    const { chunkIndex, encryptedData } = parseChunkMessage(data)
                    const decryptedChunk = await decryptChunk(key!, encryptedData)

                    // Calculate write position based on chunk index
                    const writePosition = chunkIndex * ENCRYPTION_CHUNK_SIZE

                    // Ensure buffer is large enough (for text messages or unknown sizes)
                    const requiredSize = writePosition + decryptedChunk.length
                    if (!combinedBuffer || combinedBuffer.length < requiredSize) {
                      const newBuffer = new Uint8Array(Math.max(requiredSize, (combinedBuffer?.length || 0) * 2))
                      if (combinedBuffer) {
                        newBuffer.set(combinedBuffer)
                      }
                      combinedBuffer = newBuffer
                    }

                    // Write directly to position in buffer - no intermediate storage!
                    combinedBuffer.set(decryptedChunk, writePosition)
                    receivedChunkIndices.add(chunkIndex)
                    totalDecryptedBytes += decryptedChunk.length

                    // Update progress
                    const totalBytes = resolvedFileSize
                    setState(s => ({
                      ...s,
                      status: 'receiving',
                      progress: {
                        current: totalDecryptedBytes,
                        total: totalBytes
                      }
                    }))
                  } catch (err) {
                    console.error('Failed to decrypt chunk:', err)
                    // Don't reject immediately - might be a transient error
                  }
                })()
                pendingChunkPromises.add(decryptPromise)
                decryptPromise.finally(() => {
                  pendingChunkPromises.delete(decryptPromise)
                })
              }
            }
          )
          return rtc
        }

        // Handle chunk notification (cloud fallback)
        const handleChunkNotify = async (chunkPayload: ChunkNotifyPayload) => {
          if (settled) return

          // First chunk notification - switch to cloud mode
          if (!cloudTransferStarted) {
            cloudTransferStarted = true
            console.log('Switching to cloud chunk download mode')

            // Close any pending WebRTC connection
            if (rtc) {
              rtc.close()
              rtc = null
            }

            // Pre-allocate buffer for encrypted cloud data
            // Cloud chunks are encrypted, so we estimate size based on totalChunks * chunkSize
            // Add some overhead for encryption (28 bytes per original chunk, but cloud encrypts whole content)
            const estimatedEncryptedSize = chunkPayload.totalChunks * CLOUD_CHUNK_SIZE
            cloudBuffer = new Uint8Array(estimatedEncryptedSize)
          }

          expectedTotalChunks = chunkPayload.totalChunks

          setState(s => ({
            ...s,
            message: `Downloading chunk ${chunkPayload.chunkIndex + 1}/${chunkPayload.totalChunks}...`,
            useWebRTC: false,
          }))

          try {
            // Download this chunk
            const chunkData = await downloadFromCloud(
              chunkPayload.chunkUrl,
              (loaded) => {
                setState(s => ({
                  ...s,
                  progress: {
                    current: cloudTotalBytes + loaded,
                    total: resolvedFileSize,
                  },
                }))
              }
            )

            // Validate chunk size
            if (chunkData.length !== chunkPayload.chunkSize) {
              console.warn(`Chunk ${chunkPayload.chunkIndex} size mismatch: expected ${chunkPayload.chunkSize}, got ${chunkData.length}`)
            }

            // Calculate write position based on chunk index and cloud chunk size
            const writePosition = chunkPayload.chunkIndex * CLOUD_CHUNK_SIZE

            // Ensure buffer is large enough
            const requiredSize = writePosition + chunkData.length
            if (!cloudBuffer || cloudBuffer.length < requiredSize) {
              const newBuffer = new Uint8Array(Math.max(requiredSize, (cloudBuffer?.length || 0) * 2))
              if (cloudBuffer) {
                newBuffer.set(cloudBuffer)
              }
              cloudBuffer = newBuffer
            }

            // Write directly to position in buffer - no intermediate storage!
            cloudBuffer.set(chunkData, writePosition)
            receivedCloudChunkIndices.add(chunkPayload.chunkIndex)
            cloudTotalBytes += chunkData.length

            console.log(`Chunk ${chunkPayload.chunkIndex + 1}/${chunkPayload.totalChunks} downloaded (${chunkData.length} bytes)`)

            // Send chunk ACK (seq = chunkIndex + 1, 1-based)
            const chunkAck = createAckEvent(
              secretKey,
              senderPubkey!,
              transferId!,
              chunkPayload.chunkIndex + 1
            )
            await publishWithBackup(client, chunkAck)
            console.log(`Chunk ${chunkPayload.chunkIndex + 1} ACK sent`)

            // Check if all chunks received
            if (receivedCloudChunkIndices.size === expectedTotalChunks) {
              settled = true
              clearTimeout(overallTimeout)
              client.unsubscribe(subId)

              // Buffer is already assembled - just trim to actual size
              const result = cloudBuffer.slice(0, cloudTotalBytes)
              console.log(`All ${expectedTotalChunks} cloud chunks assembled (${cloudTotalBytes} bytes)`)
              resolve({ mode: 'cloud', data: result })
            }
          } catch (err) {
            console.error(`Failed to download chunk ${chunkPayload.chunkIndex}:`, err)
            // Don't reject immediately - sender might resend
          }
        }

        // Track processed event IDs to avoid duplicates
        const processedEventIds = new Set<string>()

        // Process an event (signal or chunk notification)
        const processEvent = async (event: Event) => {
          if (settled) return
          if (processedEventIds.has(event.id)) return
          processedEventIds.add(event.id)

          // Check for WebRTC signal (only if cloud transfer hasn't started)
          if (!cloudTransferStarted) {
            const signalData = parseSignalingEvent(event)
            if (signalData && signalData.transferId === transferId) {
              try {
                const decrypted = await decrypt(key!, signalData.encryptedSignal)
                const signalPayload = JSON.parse(new TextDecoder().decode(decrypted))
                if (signalPayload.type === 'signal' && signalPayload.signal) {
                  console.log('Received WebRTC signal:', signalPayload.signal.type || 'candidate')
                  const r = initWebRTC()
                  r.handleSignal(signalPayload.signal)
                }
              } catch (e) {
                console.error("Signal handling error", e)
              }
              return
            }
          }

          // Check for chunk notification (cloud fallback)
          const chunkNotify = parseChunkNotifyEvent(event)
          if (chunkNotify && chunkNotify.transferId === transferId) {
            // Avoid processing duplicate chunk notifications
            if (!receivedCloudChunkIndices.has(chunkNotify.chunkIndex)) {
              await handleChunkNotify(chunkNotify)
            }
          }
        }

        // Listen for both WebRTC signals AND chunk notifications from sender
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

          // Query for existing events that may have arrived before subscription
          // This fixes race condition where sender's offer arrives before receiver subscribes
          ; (async () => {
            try {
              const existingEvents = await client.query([
                {
                  kinds: [EVENT_KIND_DATA_TRANSFER],
                  '#t': [transferId!],
                  authors: [senderPubkey!],
                  limit: 50,
                },
              ])
              console.log(`Found ${existingEvents.length} existing events for transfer`)
              for (const event of existingEvents) {
                await processEvent(event)
              }
            } catch (err) {
              console.error('Failed to query existing events:', err)
            }
          })()

      })

      if (cancelledRef.current) return

      // Process received data
      let contentData: Uint8Array

      if (transferResult.mode === 'p2p') {
        // P2P data is already decrypted on-the-fly during reception
        contentData = transferResult.data
        webRTCSuccess = true
        console.log('Received and decrypted data via P2P')
      } else {
        // Cloud data is encrypted - need to decrypt
        setState(s => ({ ...s, message: 'Decrypting...' }))
        contentData = await decrypt(key, transferResult.data)
        console.log('Downloaded and decrypted data from cloud storage')
      }

      if (cancelledRef.current) return

      // Send completion ACK
      console.log(`Sending completion ACK (seq=-1) for transfer ${transferId}`)
      const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
      await publishWithBackup(client, completeAck)
      console.log(`✓ Completion ACK sent successfully`)

      // Set received content
      setReceivedContent({
        contentType: 'file',
        data: contentData,
        fileName: resolvedFileName,
        fileSize: resolvedFileSize,
        mimeType: resolvedMimeType,
      })
      setState(prevState => ({
        status: 'complete',
        message: webRTCSuccess ? 'File received (P2P)!' : 'File received!',
        contentType: 'file',
        fileMetadata: {
          fileName: resolvedFileName,
          fileSize: resolvedFileSize,
          mimeType: resolvedMimeType,
        },
        currentRelays: prevState.currentRelays, // Preserve for debugging
        useWebRTC: prevState.useWebRTC,
      }))
    } catch (error) {
      if (!cancelledRef.current) {
        setState(prevState => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
        }))
      }
    } finally {
      // Always clean up resources and reset receiving flag
      receivingRef.current = false
      if (clientRef.current) {
        clientRef.current.close()
        clientRef.current = null
      }
    }
  }, [])

  return { state, receivedContent, receive, cancel, reset }
}
