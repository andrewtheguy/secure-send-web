import { useState, useCallback, useRef } from 'react'
import {
  generatePin,
  computePinHint,
  generateTransferId,
  generateSalt,
  deriveKeyFromPin,
  encrypt,
  decrypt,
  CHUNK_SIZE,
  MAX_MESSAGE_SIZE,
  MAX_RELAY_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  createPinExchangeEvent,
  createChunkEvent,
  parseAckEvent,
  discoverBestRelays,
  discoverBackupRelays,
  createSignalingEvent,
  parseSignalingEvent,
  DEFAULT_RELAYS,
  type TransferState,
  type PinExchangePayload,
  type ContentType,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
  type WebRTCOptions,
} from '@/lib/nostr'
import type { Event } from 'nostr-tools'
import { readFileAsBytes } from '@/lib/file-utils'
import { WebRTCConnection } from '@/lib/webrtc'

// Throttling constants
const RELAY_CHUNK_DELAY_MS = 1000  // 1 second delay between chunk sends
const RETRY_PAUSE_MS = 500         // 500ms pause after retry

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

export interface UseNostrSendReturn {
  state: TransferState
  pin: string | null
  send: (content: string | File, options?: WebRTCOptions) => Promise<void>
  cancel: () => void
}

export function useNostrSend(): UseNostrSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' })
  const [pin, setPin] = useState<string | null>(null)

  const clientRef = useRef<NostrClient | null>(null)
  const cancelledRef = useRef(false)
  const sendingRef = useRef(false)
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearExpirationTimeout = useCallback(() => {
    if (expirationTimeoutRef.current) {
      clearTimeout(expirationTimeoutRef.current)
      expirationTimeoutRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    sendingRef.current = false
    clearExpirationTimeout()
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
    }
    setPin(null)
    setState({ status: 'idle' })
  }, [clearExpirationTimeout])

  const send = useCallback(async (content: string | File, options?: WebRTCOptions) => {
    // Guard against concurrent invocations
    if (sendingRef.current) return
    sendingRef.current = true
    cancelledRef.current = false

    const isFile = content instanceof File
    const contentType: ContentType = isFile ? 'file' : 'text'

    try {
      // Get content bytes
      let contentBytes: Uint8Array
      let fileName: string | undefined
      let fileSize: number | undefined
      let mimeType: string | undefined

      // Use smaller limit when relay-only mode is enabled
      const sizeLimit = options?.relayOnly ? MAX_RELAY_MESSAGE_SIZE : MAX_MESSAGE_SIZE

      if (isFile) {
        fileName = content.name
        fileSize = content.size
        mimeType = content.type || 'application/octet-stream'

        if (content.size > sizeLimit) {
          const limitKB = sizeLimit / 1024
          setState({ status: 'error', message: `File exceeds ${limitKB}KB limit` })
          return
        }

        setState({ status: 'connecting', message: 'Reading file...' })
        contentBytes = await readFileAsBytes(content)
      } else {
        const encoder = new TextEncoder()
        contentBytes = encoder.encode(content)

        if (contentBytes.length > sizeLimit) {
          const limitKB = sizeLimit / 1024
          setState({ status: 'error', message: `Message exceeds ${limitKB}KB limit` })
          return
        }
      }
      // Generate PIN and derive key
      setState({ status: 'connecting', message: 'Generating secure PIN...' })
      const newPin = generatePin()
      const sessionStartTime = Date.now() // Track session start for TTL enforcement
      setPin(newPin)

      // Best-effort cleanup: clear PIN state after expiration
      // Only clears if still waiting for receiver (not actively transferring)
      clearExpirationTimeout()
      expirationTimeoutRef.current = setTimeout(() => {
        // Only clear if we're still in waiting state and not cancelled
        if (!cancelledRef.current && sendingRef.current) {
          setPin(null)
          setState({ status: 'error', message: 'Session expired. Please try again.' })
          sendingRef.current = false
          if (clientRef.current) {
            clientRef.current.close()
            clientRef.current = null
          }
        }
      }, TRANSFER_EXPIRATION_MS)

      const [pinHint, salt] = await Promise.all([computePinHint(newPin), Promise.resolve(generateSalt())])
      const key = await deriveKeyFromPin(newPin, salt)

      if (cancelledRef.current) return

      // Generate ephemeral keypair
      const { secretKey, publicKey } = generateEphemeralKeys()
      const transferId = generateTransferId()

      // Discover best relays for data transfer
      setState({ status: 'connecting', message: 'Discovering best relays...' })
      const bestRelays = await discoverBestRelays()
      if (cancelledRef.current) return

      // Use ALL seed relays for PIN exchange (maximum discoverability)
      let client = createNostrClient([...DEFAULT_RELAYS])
      clientRef.current = client

      if (cancelledRef.current) return

      // Calculate chunks
      const totalChunks = Math.ceil(contentBytes.length / CHUNK_SIZE)

      // Initialize chunk tracking for relay mode (multi-chunk transfers)
      const chunkStates = new Map<number, { seq: number; status: 'pending' | 'sending' | 'sent' | 'acked'; retries?: number; timestamp?: number }>()
      if (totalChunks > 1) {
        for (let i = 0; i < totalChunks; i++) {
          chunkStates.set(i, { seq: i, status: 'pending' })
        }
      }

      // Create and encrypt PIN exchange payload (include best relays for data transfer)
      const payload: PinExchangePayload = {
        contentType,
        transferId,
        senderPubkey: publicKey,
        totalChunks,
        relays: bestRelays, // Sender's preferred relays for data transfer
        // For text, include message if single chunk
        textMessage: contentType === 'text' && totalChunks <= 1 ? (content as string) : undefined,
        // For file, include metadata
        fileName: contentType === 'file' ? fileName : undefined,
        fileSize: contentType === 'file' ? fileSize : undefined,
        mimeType: contentType === 'file' ? mimeType : undefined,
      }

      const encoder = new TextEncoder()
      const payloadBytes = encoder.encode(JSON.stringify(payload))
      const encryptedPayload = await encrypt(key, payloadBytes)

      // Publish PIN exchange event
      setState({
        status: 'waiting_for_receiver',
        message: 'Waiting for receiver...',
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
        chunks: totalChunks > 1 ? chunkStates : undefined,
        useWebRTC: !options?.relayOnly,
        currentRelays: client.getRelays(),
      })
      const pinExchangeEvent = createPinExchangeEvent(secretKey, encryptedPayload, salt, transferId, pinHint)
      await publishWithBackup(client, pinExchangeEvent)

      if (cancelledRef.current) return

      // Ensure connection is ready before subscribing
      await client.waitForConnection()

      // Wait for receiver ready ACK (seq=0)
      const receiverPubkey = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          client.unsubscribe(subId)
          // Don't reject if already cancelled to avoid race condition
          if (!cancelledRef.current) {
            reject(new Error('Timeout waiting for receiver'))
          }
        }, 60 * 60 * 1000) // 1 hour timeout

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
              clearTimeout(timeout)
              client.unsubscribe(subId)
              reject(new Error('Cancelled'))
              return
            }

            const ack = parseAckEvent(event)
            if (ack && ack.transferId === transferId && ack.seq === 0) {
              clearTimeout(timeout)
              client.unsubscribe(subId)
              resolve(event.pubkey)
            }
          }
        )
      })

      if (cancelledRef.current) return

      // Receiver connected - PIN no longer needed
      setPin(null)

      // Enforce TTL: reject if session has expired
      if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
        throw new Error('Session expired. Please start a new transfer.')
      }

      // Switch to best relays for data transfer
      client.close()
      client = createNostrClient(bestRelays)
      clientRef.current = client
      // Wait for new connections to be ready
      await client.waitForConnection()

      if (cancelledRef.current) return

      // WebRTC Transfer Logic
      let webRTCSuccess = false
      if (!options?.relayOnly) {
        try {
          setState({ status: 'connecting', message: 'Attempting P2P connection...' })

          await new Promise<void>((resolve, reject) => {
            const rtc = new WebRTCConnection(
              { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
              async (signal) => {
                // Send signal via Nostr
                if (cancelledRef.current) return
                const signalPayload = {
                  type: 'signal',
                  signal
                }
                const signalJson = JSON.stringify(signalPayload)
                const encryptedSignal = await encrypt(key, new TextEncoder().encode(signalJson))

                // Send as data transfer event with specific tag? 
                // Using existing structure, maybe just send as chunk? No, better use a different structure or rely on implied type.
                // Let's use a specific "signal" type in tags if possible, or just identifiable payload.
                // For now, let's wrap it in a way receiver can distinguish.
                // Actually, let's just use the same channel.

                // Use createSignalingEvent
                const event = createSignalingEvent(secretKey, publicKey, transferId, encryptedSignal)

                await client.publish(event)
              },
              async () => {
                // DataChannel open
                console.log('WebRTC connected, sending data...')
                setState({ status: 'transferring', message: 'Sending via P2P...' })

                try {
                  // Send file content
                  // For simplicity, send whole buffer if it fits, or chunk it for progress
                  const chunkSize = 16384 // 16KB chunks for data channel
                  for (let i = 0; i < contentBytes.length; i += chunkSize) {
                    if (cancelledRef.current) throw new Error('Cancelled')
                    const end = Math.min(i + chunkSize, contentBytes.length)
                    rtc.send(contentBytes.slice(i, end))

                    // Update progress occasionally
                    if (i % (chunkSize * 10) === 0) {
                      setState(s => ({ ...s, progress: { current: i, total: contentBytes.length } }))
                    }
                  }

                  // Send "DONE" message or close
                  rtc.send('DONE')
                  webRTCSuccess = true
                  resolve()
                } catch (err) {
                  reject(err)
                }
              },
              (data) => {
                // Handle messages from receiver (e.g. "DONE_ACK")
                if (data === 'DONE_ACK') {
                  // remote confirmed receipt
                }
              }
            )

            // Listen for signals from receiver
            const subId = client.subscribe(
              [
                {
                  kinds: [EVENT_KIND_DATA_TRANSFER],
                  '#t': [transferId],
                  '#p': [publicKey],
                  authors: [receiverPubkey],
                },
              ],
              async (event) => {
                // Check if it's a signal event
                const signalData = parseSignalingEvent(event)
                if (signalData && signalData.transferId === transferId) {
                  try {
                    const decrypted = await decrypt(key, signalData.encryptedSignal)
                    const payload = JSON.parse(new TextDecoder().decode(decrypted))
                    if (payload.type === 'signal' && payload.signal) {
                      rtc.handleSignal(payload.signal)
                    }
                  } catch (err) {
                    console.error('Failed to process signaling event:', err, {
                      transferId,
                      eventId: event.id
                    })
                    // Ignore malformed signal and continue
                  }
                }
              }
            )

            // Initiate
            rtc.createDataChannel('file-transfer')
            rtc.createOffer()

            // Timeout for WebRTC setup
            setTimeout(() => {
              if (!webRTCSuccess) {
                rtc.close()
                client.unsubscribe(subId)
                reject(new Error('WebRTC timeout'))
              }
            }, 10000) // 10 seconds to connect

          })
        } catch (err) {
          console.log('WebRTC failed, falling back to relay:', err)
          // Continue to relay fallback
        }
      }

      if (webRTCSuccess) {
        setState({ status: 'complete', message: 'Sent via P2P!', contentType })
        return
      }

      // Fallback to relay mode - enforce 512KB limit
      if (contentBytes.length > MAX_RELAY_MESSAGE_SIZE) {
        throw new Error('File exceeds 512KB limit for relay transfer')
      }

      // If content fits in single chunk (text only), wait for completion ACK
      if (contentType === 'text' && totalChunks <= 1) {
        await waitForChunkAck(client, transferId, publicKey, receiverPubkey, -1, () => cancelledRef.current)
        setState({ status: 'complete', message: 'Message sent successfully!', contentType })
        return
      }

      // Send chunks one by one, waiting for ACK after each
      for (let i = 0; i < totalChunks; i++) {
        if (cancelledRef.current) return

        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, contentBytes.length)
        const chunkData = contentBytes.slice(start, end)
        const encryptedChunk = await encrypt(key, chunkData)

        if (cancelledRef.current) return

        const chunkEvent = createChunkEvent(secretKey, transferId, i, totalChunks, encryptedChunk)

        // Send chunk and wait for ACK, resending if no ACK received
        let ackReceived = false
        let retryCount = 0
        const maxRetries = 3
        let usedBackupRelays = false

        while (!ackReceived && retryCount < maxRetries) {
          if (cancelledRef.current) return

          // Update chunk state to sending
          chunkStates.set(i, { seq: i, status: 'sending', retries: retryCount, timestamp: Date.now() })

          try {
            await client.publish(chunkEvent)
            console.log(`✓ Chunk ${i} published successfully`)

            // Update chunk state to sent
            chunkStates.set(i, { seq: i, status: 'sent', retries: retryCount, timestamp: Date.now() })

            setState({
              status: 'transferring',
              message: retryCount > 0
                ? `Resending chunk ${i + 1}/${totalChunks} (attempt ${retryCount + 1})...`
                : `Sending chunk ${i + 1}/${totalChunks}...`,
              progress: { current: i + 1, total: totalChunks },
              contentType,
              fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
              chunks: chunkStates,
              currentRelays: client.getRelays(),
            })

            // Wait for ACK with timeout
            ackReceived = await waitForChunkAck(client, transferId, publicKey, receiverPubkey, i, () => cancelledRef.current, 10000)

            if (!ackReceived) {
              retryCount++
              console.log(`✗ No ACK for chunk ${i}, retrying (${retryCount}/${maxRetries})`)
              await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS))
            } else {
              // Mark chunk as acked
              console.log(`✓ ACK received for chunk ${i}`)
              chunkStates.set(i, { seq: i, status: 'acked', retries: retryCount, timestamp: Date.now() })
            }
          } catch (publishError) {
            // Publish failed - will trigger backup relay discovery below
            console.error(`Failed to publish chunk ${i}:`, publishError)
            retryCount++
            if (retryCount < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS))
            }
          }
        }

        // If still no ACK after 3 attempts, try backup relays
        if (!ackReceived && !usedBackupRelays) {
          console.log(`Chunk ${i} failed after ${maxRetries} attempts, discovering backup relays...`)

          setState({
            status: 'transferring',
            message: `Chunk ${i + 1}/${totalChunks} failed, discovering backup relays...`,
            progress: { current: i + 1, total: totalChunks },
            contentType,
            fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
            chunks: chunkStates,
            currentRelays: client.getRelays(),
          })

          const currentRelays = client.getRelays()
          const backupRelays = await discoverBackupRelays(currentRelays, 5)

          if (backupRelays.length > 0) {
            await client.addRelays(backupRelays)
            usedBackupRelays = true
            retryCount = 0

            // Retry with backup relays
            while (!ackReceived && retryCount < maxRetries) {
              if (cancelledRef.current) return

              // Update chunk state to sending
              chunkStates.set(i, { seq: i, status: 'sending', retries: retryCount, timestamp: Date.now() })

              try {
                await client.publish(chunkEvent)
                console.log(`✓ Chunk ${i} published via backup relays`)

                // Update chunk state to sent
                chunkStates.set(i, { seq: i, status: 'sent', retries: retryCount, timestamp: Date.now() })

                setState({
                  status: 'transferring',
                  message: `Resending chunk ${i + 1}/${totalChunks} via backup relays (attempt ${retryCount + 1})...`,
                  progress: { current: i + 1, total: totalChunks },
                  contentType,
                  fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
                  chunks: chunkStates,
                  currentRelays: client.getRelays(),
                })

                ackReceived = await waitForChunkAck(client, transferId, publicKey, receiverPubkey, i, () => cancelledRef.current, 10000)

                if (!ackReceived) {
                  retryCount++
                  console.log(`✗ No ACK for chunk ${i} via backup relays, retrying (${retryCount}/${maxRetries})`)
                  await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS))
                } else {
                  // Mark chunk as acked
                  console.log(`✓ ACK received for chunk ${i} via backup relays`)
                  chunkStates.set(i, { seq: i, status: 'acked', retries: retryCount, timestamp: Date.now() })
                }
              } catch (publishError) {
                // Publish failed even on backup relays
                console.error(`Failed to publish chunk ${i} via backup relays:`, publishError)
                retryCount++
                if (retryCount < maxRetries) {
                  await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS))
                }
              }
            }
          }
        }

        if (!ackReceived) {
          throw new Error(`Failed to receive ACK for chunk ${i} after ${maxRetries} attempts${usedBackupRelays ? ' (including backup relays)' : ''}`)
        }

        // Sleep 1 second between chunk sends (except after last chunk)
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, RELAY_CHUNK_DELAY_MS))
        }
      }

      // Wait for completion ACK (seq=-1) with longer timeout
      let completionReceived = false
      let completionRetries = 0
      while (!completionReceived && completionRetries < 30) {
        if (cancelledRef.current) return
        completionReceived = await waitForChunkAck(client, transferId, publicKey, receiverPubkey, -1, () => cancelledRef.current, 10000)
        if (!completionReceived) {
          completionRetries++
          console.log(`Waiting for completion ACK (${completionRetries}/30)...`)
        }
      }

      if (!completionReceived) {
        throw new Error('Failed to receive completion ACK')
      }

      const successMsg = isFile ? 'File sent successfully!' : 'Message sent successfully!'
      setState({ status: 'complete', message: successMsg, contentType })
    } catch (error) {
      if (!cancelledRef.current) {
        setPin(null)
        setState(prevState => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to send',
        }))
      }
    } finally {
      // Always clean up resources and reset sending flag
      clearExpirationTimeout()
      sendingRef.current = false
      if (clientRef.current) {
        clientRef.current.close()
        clientRef.current = null
      }
    }
  }, [clearExpirationTimeout])

  return { state, pin, send, cancel }
}

/**
 * Wait for ACK with specific sequence number from receiver.
 * Returns true if ACK received, false if timeout.
 */
async function waitForChunkAck(
  client: NostrClient,
  transferId: string,
  senderPubkey: string,
  receiverPubkey: string,
  expectedSeq: number,
  isCancelled: () => boolean,
  timeoutMs: number = 30000
): Promise<boolean> {
  return new Promise(async (resolve) => {
    let resolved = false

    // First, query for existing ACK in case it was sent before subscription was created
    try {
      const existingEvents = await client.query([
        {
          kinds: [EVENT_KIND_DATA_TRANSFER],
          '#t': [transferId],
          '#p': [senderPubkey],
          authors: [receiverPubkey],
          limit: 50, // Check recent ACKs
        },
      ])

      for (const event of existingEvents) {
        const ack = parseAckEvent(event)
        if (ack && ack.transferId === transferId && ack.seq === expectedSeq) {
          // Found the ACK in query results
          resolve(true)
          return
        }
      }
    } catch (err) {
      console.error('Failed to query for existing ACK:', err)
      // Continue to subscription even if query fails
    }

    if (isCancelled()) {
      resolve(false)
      return
    }

    // ACK not found in query, set up subscription to wait for it
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        client.unsubscribe(subId)
        resolve(false) // Timeout - no ACK received
      }
    }, timeoutMs)

    const subId = client.subscribe(
      [
        {
          kinds: [EVENT_KIND_DATA_TRANSFER],
          '#t': [transferId],
          '#p': [senderPubkey],
          authors: [receiverPubkey],
        },
      ],
      (event) => {
        if (resolved) return

        if (isCancelled()) {
          resolved = true
          clearTimeout(timeout)
          client.unsubscribe(subId)
          resolve(false)
          return
        }

        const ack = parseAckEvent(event)
        if (ack && ack.transferId === transferId && ack.seq === expectedSeq) {
          resolved = true
          clearTimeout(timeout)
          client.unsubscribe(subId)
          resolve(true) // ACK received
        }
      }
    )
  })
}
