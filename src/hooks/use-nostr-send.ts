import { useState, useCallback, useRef } from 'react'
import {
  generatePinForMethod,
  computePinHint,
  generateTransferId,
  generateSalt,
  deriveKeyFromPin,
  encrypt,
  decrypt,
  encryptChunk,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
  CLOUD_CHUNK_SIZE,
  ENCRYPTION_CHUNK_SIZE,
  getCredentialFingerprint,
  deriveKeyFromPasskeyWithSalt,
  generatePasskeyPin,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  createPinExchangeEvent,
  parseAckEvent,
  discoverBackupRelays,
  createSignalingEvent,
  parseSignalingEvent,
  createChunkNotifyEvent,
  DEFAULT_RELAYS,
  type TransferState,
  type PinExchangePayload,
  type ContentType,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
  type WebRTCOptions,
} from '@/lib/nostr'
import { uploadToCloud, splitIntoChunks } from '@/lib/cloud-storage'
import type { Event } from 'nostr-tools'
import { readFileAsBytes } from '@/lib/file-utils'
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

export interface UseNostrSendReturn {
  state: TransferState
  pin: string | null
  send: (content: File, options?: WebRTCOptions) => Promise<void>
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

  const send = useCallback(async (content: File, options?: WebRTCOptions) => {
    // Guard against concurrent invocations
    if (sendingRef.current) return
    sendingRef.current = true
    cancelledRef.current = false

    const contentType: ContentType = 'file'

    try {
      // Validate and sanitize metadata
      const rawFileName = content.name || ''
      const sanitizedFileName = rawFileName.trim()

      if (!sanitizedFileName) {
        setState({ status: 'error', message: 'Missing file name' })
        sendingRef.current = false
        return
      }

      const fileName = sanitizedFileName
      const fileSize = content.size
      const mimeType = content.type || 'application/octet-stream'

      if (typeof fileSize !== 'number' || !Number.isFinite(fileSize)) {
        setState({ status: 'error', message: 'Invalid file size' })
        sendingRef.current = false
        return
      }

      if (fileSize <= 0) {
        setState({ status: 'error', message: 'File is empty' })
        sendingRef.current = false
        return
      }

      if (fileSize > MAX_MESSAGE_SIZE) {
        const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024
        setState({ status: 'error', message: `File exceeds ${limitMB}MB limit` })
        sendingRef.current = false
        return
      }

      setState({ status: 'connecting', message: 'Reading file...' })
      const contentBytes = await readFileAsBytes(content)

      // Generate PIN/passkey and derive key
      const sessionStartTime = Date.now()
      const salt = generateSalt()
      let newPin: string
      let key: CryptoKey
      let pinHint: string

      if (options?.usePasskey) {
        // Passkey mode: authenticate and derive key from passkey
        setState({ status: 'connecting', message: 'Authenticate with passkey...' })
        try {
          // Get credential fingerprint (prompts for passkey authentication)
          const fingerprint = await getCredentialFingerprint()
          // Derive key from passkey (prompts again - this is the PRF derivation)
          key = await deriveKeyFromPasskeyWithSalt(salt)
          // Generate passkey "PIN" for display ('P' + fingerprint)
          newPin = generatePasskeyPin(fingerprint)
          // For passkey, pinHint is just the fingerprint (receiver identifies by 'P' prefix)
          pinHint = fingerprint
        } catch (err) {
          setState({ status: 'error', message: err instanceof Error ? err.message : 'Passkey authentication failed' })
          sendingRef.current = false
          return
        }
      } else {
        // Regular PIN mode
        setState({ status: 'connecting', message: 'Generating secure PIN...' })
        newPin = generatePinForMethod('nostr')
        pinHint = await computePinHint(newPin)
        key = await deriveKeyFromPin(newPin, salt)
      }

      setPin(newPin)

      // Best-effort cleanup: clear PIN state after expiration
      clearExpirationTimeout()
      expirationTimeoutRef.current = setTimeout(() => {
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

      if (cancelledRef.current) return

      // Generate ephemeral keypair
      const { secretKey, publicKey } = generateEphemeralKeys()
      const transferId = generateTransferId()

      if (cancelledRef.current) return

      // Note: Content encryption is deferred until needed (cloud fallback only)
      // P2P sends raw content since WebRTC data channel is already secure

      // Create Nostr client for signaling
      setState({ status: 'connecting', message: 'Connecting to relays...' })
      const client = createNostrClient([...DEFAULT_RELAYS])
      clientRef.current = client

      // Create PIN exchange payload WITHOUT cloud URL
      // Cloud upload only happens if P2P fails
      // Estimate totalChunks based on raw size (encryption adds ~28 bytes overhead per chunk)
      const estimatedEncryptedSize = contentBytes.length + 28
      const payload: PinExchangePayload = {
        contentType,
        transferId,
        senderPubkey: publicKey,
        totalChunks: Math.ceil(estimatedEncryptedSize / CLOUD_CHUNK_SIZE),
        relays: [...DEFAULT_RELAYS],
        // NO tmpfilesUrl - cloud upload only if P2P fails
        fileName,
        fileSize,
        mimeType,
      }

      const encoder = new TextEncoder()
      const payloadBytes = encoder.encode(JSON.stringify(payload))
      const encryptedPayload = await encrypt(key, payloadBytes)

      // Publish PIN exchange event
      setState({
        status: 'waiting_for_receiver',
        message: 'Waiting for receiver...',
        contentType,
        fileMetadata: { fileName, fileSize, mimeType },
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

      // WebRTC Transfer Logic (optional P2P for faster transfer)
      let webRTCSuccess = false
      let p2pConnectionEstablished = false // Track if P2P was established (no cloud fallback after this)

      if (!options?.relayOnly) {
        try {
          setState(prevState => ({
            ...prevState,
            status: 'connecting',
            message: 'Attempting P2P connection...',
          }))

          await new Promise<void>((resolve, reject) => {
            let connectionTimeout: ReturnType<typeof setTimeout> | null = null
            let offerRetryInterval: ReturnType<typeof setInterval> | null = null
            let signalSubId: string | null = null
            let answerReceived = false
            const processedEventIds = new Set<string>()

            // Helper to process signal events (used by both subscription and query)
            const processSignalEvent = async (event: Event) => {
              if (processedEventIds.has(event.id)) return
              processedEventIds.add(event.id)

              const signalData = parseSignalingEvent(event)
              if (signalData && signalData.transferId === transferId) {
                try {
                  const decrypted = await decrypt(key, signalData.encryptedSignal)
                  const payload = JSON.parse(new TextDecoder().decode(decrypted))
                  if (payload.type === 'signal' && payload.signal) {
                    console.log('Received WebRTC signal:', payload.signal.type || 'candidate')
                    if (payload.signal.type === 'answer') {
                      answerReceived = true
                      // Stop retrying offers once we get an answer
                      if (offerRetryInterval) {
                        clearInterval(offerRetryInterval)
                        offerRetryInterval = null
                      }
                    }
                    rtc.handleSignal(payload.signal)
                  }
                } catch (err) {
                  console.error('Failed to process signaling event:', err)
                }
              }
            }

            // Cleanup helper
            const cleanup = () => {
              if (connectionTimeout) {
                clearTimeout(connectionTimeout)
                connectionTimeout = null
              }
              if (offerRetryInterval) {
                clearInterval(offerRetryInterval)
                offerRetryInterval = null
              }
              if (signalSubId) {
                client.unsubscribe(signalSubId)
                signalSubId = null
              }
            }

            const rtc = new WebRTCConnection(
              { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
              async (signal) => {
                // Send signal via Nostr
                if (cancelledRef.current) return
                const signalPayload = { type: 'signal', signal }
                const signalJson = JSON.stringify(signalPayload)
                const encryptedSignal = await encrypt(key, new TextEncoder().encode(signalJson))
                const event = createSignalingEvent(secretKey, publicKey, transferId, encryptedSignal)
                await client.publish(event)
              },
              async () => {
                // DataChannel open - P2P connection established!
                if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
                  try {
                    rtc.close()
                  } catch {
                    // ignore
                  }
                  cleanup()
                  reject(new Error('Session expired. Please start a new transfer.'))
                  return
                }

                cleanup()

                // Mark P2P as established - NO cloud fallback after this point
                p2pConnectionEstablished = true

                console.log('WebRTC connected, sending data...')
                setState(prevState => ({
                  status: 'transferring',
                  message: 'Sending via P2P...',
                  progress: { current: 0, total: contentBytes.length },
                  contentType,
                  fileMetadata: { fileName, fileSize, mimeType },
                  currentRelays: prevState.currentRelays, // Preserve for debugging
                  useWebRTC: true,
                }))

                try {
                  // Encrypt and send content in 64KB chunks on-the-fly
                  // Each chunk is encrypted separately with unique nonce
                  let chunkIndex = 0
                  const totalChunks = Math.ceil(contentBytes.length / ENCRYPTION_CHUNK_SIZE)

                  for (let i = 0; i < contentBytes.length; i += ENCRYPTION_CHUNK_SIZE) {
                    if (cancelledRef.current) throw new Error('Cancelled')

                    const end = Math.min(i + ENCRYPTION_CHUNK_SIZE, contentBytes.length)
                    const plainChunk = contentBytes.slice(i, end)

                    // Encrypt this chunk with chunk index prefix
                    const encryptedChunk = await encryptChunk(key, plainChunk, chunkIndex)

                    // Send encrypted chunk as single message
                    // WebRTC data channel handles fragmentation internally
                    await rtc.sendWithBackpressure(encryptedChunk)

                    chunkIndex++

                    // Update progress based on original file size
                    setState(s => ({
                      ...s,
                      progress: { current: end, total: contentBytes.length },
                    }))
                  }

                  // Send "DONE:N" message with total chunk count for verification
                  rtc.send(`DONE:${totalChunks}`)
                  console.log(`P2P transfer complete: sent ${totalChunks} encrypted chunks`)
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
            signalSubId = client.subscribe(
              [
                {
                  kinds: [EVENT_KIND_DATA_TRANSFER],
                  '#t': [transferId],
                  '#p': [publicKey],
                  authors: [receiverPubkey],
                },
              ],
              processSignalEvent
            )

            // Query for existing answer events (in case we missed them)
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
                ])
                if (existingEvents.length > 0) {
                  console.log(`Found ${existingEvents.length} existing signal events`)
                  for (const event of existingEvents) {
                    await processSignalEvent(event)
                  }
                }
              } catch (err) {
                console.error('Failed to query existing signal events:', err)
              }
            }

            // Initiate WebRTC
            rtc.createDataChannel('file-transfer')
            rtc.createOffer()

            // Query for existing signals after initial offer
            queryForExistingSignals()

            // Retry offer every 5 seconds if no answer received
            // This helps with unreliable relay delivery
            let retryCount = 0
            offerRetryInterval = setInterval(async () => {
              if (answerReceived || webRTCSuccess || cancelledRef.current) {
                if (offerRetryInterval) {
                  clearInterval(offerRetryInterval)
                  offerRetryInterval = null
                }
                return
              }

              retryCount++
              console.log(`Retrying WebRTC offer (attempt ${retryCount + 1})...`)

              // Query for any signals we might have missed
              await queryForExistingSignals()

              // Recreate and resend offer
              if (!answerReceived && !webRTCSuccess) {
                rtc.createOffer()
              }
            }, 5000)

            // Timeout for connection establishment (30s)
            // Once data channel opens, this timeout is cleared
            connectionTimeout = setTimeout(() => {
              if (!webRTCSuccess) {
                cleanup()
                rtc.close()
                reject(new Error('WebRTC connection timeout'))
              }
            }, 30000)
          })
        } catch (err) {
          // If P2P was established but failed during transfer, abort completely (no cloud fallback)
          if (p2pConnectionEstablished) {
            throw new Error(`P2P transfer failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
          }
          // P2P connection never established - fall back to cloud
          console.log('P2P connection failed, falling back to cloud upload:', err)
        }
      }

      // Cloud fallback: Only if P2P was never established (connection timeout or disabled)
      if (!webRTCSuccess && !p2pConnectionEstablished) {
        // Enforce TTL right before any cloud upload begins
        if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
          throw new Error('Session expired. Please start a new transfer.')
        }

        // Encrypt content now (deferred from earlier since P2P doesn't need it)
        setState({
          status: 'transferring',
          message: 'Encrypting content for cloud upload...',
          contentType,
          fileMetadata: { fileName, fileSize, mimeType },
          currentRelays: client.getRelays(),
        })

        const encryptedContent = await encrypt(key, contentBytes)

        if (cancelledRef.current) return

        setState(s => ({
          ...s,
          message: 'Uploading to cloud...',
          progress: { current: 0, total: encryptedContent.length },
        }))

        // Split encrypted content into chunks for upload
        const chunks = splitIntoChunks(encryptedContent, CLOUD_CHUNK_SIZE)
        const totalChunks = chunks.length
        let uploadedBytes = 0

        console.log(`Starting chunked upload: ${totalChunks} chunks of up to ${CLOUD_CHUNK_SIZE / 1024 / 1024}MB each`)

        for (let i = 0; i < chunks.length; i++) {
          if (cancelledRef.current) return

          const chunk = chunks[i]
          setState(s => ({
            ...s,
            message: `Uploading chunk ${i + 1}/${totalChunks}...`,
            progress: { current: uploadedBytes, total: encryptedContent.length },
          }))

          // Upload this chunk
          const uploadResult = await uploadToCloud(
            chunk,
            `encrypted.chunk${i}.bin`,
            (progress: number) => {
              const chunkUploaded = Math.round((progress / 100) * chunk.length)
              setState(s => ({
                ...s,
                progress: { current: uploadedBytes + chunkUploaded, total: encryptedContent.length },
              }))
            }
          )

          console.log(`Chunk ${i + 1}/${totalChunks} uploaded to ${uploadResult.url}`)

          // Notify receiver of chunk URL
          const notifyEvent = createChunkNotifyEvent(
            secretKey,
            receiverPubkey,
            transferId,
            i,
            totalChunks,
            uploadResult.url,
            chunk.length
          )
          await client.publish(notifyEvent)
          console.log(`Chunk ${i + 1}/${totalChunks} notification sent`)

          // Wait for receiver to ACK this chunk (seq = i + 1, 1-based)
          setState(s => ({
            ...s,
            message: `Waiting for chunk ${i + 1}/${totalChunks} confirmation...`,
          }))

          const chunkAckReceived = await waitForAck(
            client,
            transferId,
            publicKey,
            receiverPubkey,
            i + 1, // chunk ACK uses 1-based indexing (0 is ready)
            () => cancelledRef.current,
            60000 // 60s timeout per chunk
          )

          if (!chunkAckReceived) {
            throw new Error(`Timeout waiting for chunk ${i + 1} confirmation`)
          }

          console.log(`Chunk ${i + 1}/${totalChunks} confirmed by receiver`)
          uploadedBytes += chunk.length
        }

        console.log('All chunks uploaded and confirmed')
      }

      // Wait for completion ACK (seq=-1)
      const completionReceived = await waitForAck(client, transferId, publicKey, receiverPubkey, -1, () => cancelledRef.current)

      if (!completionReceived) {
        throw new Error('Failed to receive completion confirmation')
      }

      const successMsg = webRTCSuccess
        ? 'File sent via P2P!'
        : 'File sent successfully!'

      setState(prevState => ({
        status: 'complete',
        message: successMsg,
        contentType,
        currentRelays: prevState.currentRelays, // Preserve for debugging
        useWebRTC: prevState.useWebRTC,
      }))
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
async function waitForAck(
  client: NostrClient,
  transferId: string,
  senderPubkey: string,
  receiverPubkey: string,
  expectedSeq: number,
  isCancelled: () => boolean,
  timeoutMs: number = 5 * 60 * 1000 // 5 minute default timeout
): Promise<boolean> {
  // First, query for existing ACK in case it was sent before subscription
  try {
    const existingEvents = await client.query([
      {
        kinds: [EVENT_KIND_DATA_TRANSFER],
        '#t': [transferId],
        '#p': [senderPubkey],
        authors: [receiverPubkey],
        limit: 50,
      },
    ])

    for (const event of existingEvents) {
      const ack = parseAckEvent(event)
      if (ack && ack.transferId === transferId && ack.seq === expectedSeq) {
        return true
      }
    }
  } catch (err) {
    console.error('Failed to query for existing ACK:', err)
  }

  if (isCancelled()) {
    return false
  }

  // ACK not found, set up subscription to wait for it
  return new Promise((resolve) => {
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        client.unsubscribe(subId)
        resolve(false)
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
          resolve(true)
        }
      }
    )
  })
}
