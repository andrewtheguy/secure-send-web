import { useState, useCallback, useRef, useMemo } from 'react'
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
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  createPinExchangeEvent,
  parseAckEvent,
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
import { getWebRTCConfig } from '@/lib/webrtc-config'

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

  const send = useCallback(
    async (content: File, options?: WebRTCOptions) => {
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

        // Generate credentials and derive key
        const sessionStartTime = Date.now()
        const salt = generateSalt()

        // PIN mode
        setState({ status: 'connecting', message: 'Generating secure PIN...' })
        const newPin = generatePinForMethod('nostr')
        const hint = await computePinHint(newPin)
        const key = await deriveKeyFromPin(newPin, salt)
        setPin(newPin)

        // Best-effort cleanup: clear state after expiration
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

        // Generate ephemeral Nostr keypair
        const { secretKey, publicKey } = generateEphemeralKeys()
        const transferId = generateTransferId()

        if (cancelledRef.current) return

        // Create Nostr client for signaling
        setState({ status: 'connecting', message: 'Connecting to relays...' })
        const client = createNostrClient([...DEFAULT_RELAYS])
        clientRef.current = client

        // Create payload
        const estimatedEncryptedSize = contentBytes.length + 28
        const payload: PinExchangePayload = {
          contentType,
          transferId,
          senderPubkey: publicKey,
          totalChunks: Math.ceil(estimatedEncryptedSize / CLOUD_CHUNK_SIZE),
          relays: [...DEFAULT_RELAYS],
          fileName,
          fileSize,
          mimeType,
        }

        const encoder = new TextEncoder()
        const payloadBytes = encoder.encode(JSON.stringify(payload))
        const encryptedPayload = await encrypt(key, payloadBytes)

        // Publish exchange event
        setState({
          status: 'waiting_for_receiver',
          message: 'Waiting for receiver...',
          contentType,
          fileMetadata: { fileName, fileSize, mimeType },
          useWebRTC: !options?.relayOnly,
          currentRelays: client.getRelays(),
          totalRelays: DEFAULT_RELAYS.length,
        })

        const exchangeEvent = createPinExchangeEvent(secretKey, encryptedPayload, salt, transferId, hint)

        await client.publish(exchangeEvent)

        if (cancelledRef.current) return

        // Ensure connection is ready before subscribing
        await client.waitForConnection()

        // Wait for receiver ready ACK (seq=0)
        const { receiverPubkey } = await new Promise<{
          receiverPubkey: string
        }>((resolve, reject) => {
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
                resolve({
                  receiverPubkey: event.pubkey,
                })
              }
            }
          )
        })

        if (cancelledRef.current) return

        // Receiver connected - credentials no longer needed for display
        setPin(null)

        // Enforce TTL: reject if session has expired
        if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
          throw new Error('Session expired. Please start a new transfer.')
        }

        // WebRTC Transfer Logic
        let webRTCSuccess = false
        let p2pConnectionEstablished = false

        if (!options?.relayOnly) {
          try {
            setState((prevState) => ({
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

              const processSignalEvent = async (event: Event) => {
                if (processedEventIds.has(event.id)) return
                processedEventIds.add(event.id)

                const signalData = parseSignalingEvent(event)
                if (signalData && signalData.transferId === transferId) {
                  try {
                    const decrypted = await decrypt(key, signalData.encryptedSignal)
                    const signalPayload = JSON.parse(new TextDecoder().decode(decrypted))
                    if (signalPayload.type === 'signal' && signalPayload.signal) {
                      if (signalPayload.signal.type === 'answer') {
                        answerReceived = true
                        if (offerRetryInterval) {
                          clearInterval(offerRetryInterval)
                          offerRetryInterval = null
                        }
                      }
                      await rtc.handleSignal(signalPayload.signal)
                    }
                  } catch (err) {
                    console.error('Failed to process signaling event:', err)
                  }
                }
              }

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
                getWebRTCConfig(),
                async (signal) => {
                  if (cancelledRef.current) return
                  const signalPayload = { type: 'signal', signal }
                  const signalJson = JSON.stringify(signalPayload)
                  const encryptedSignal = await encrypt(key, new TextEncoder().encode(signalJson))
                  const event = createSignalingEvent(
                    secretKey,
                    publicKey,
                    transferId,
                    encryptedSignal
                  )
                  await client.publish(event)
                },
                async () => {
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
                  p2pConnectionEstablished = true

                  setState((prevState) => ({
                    status: 'transferring',
                    message: 'Sending via P2P...',
                    progress: { current: 0, total: contentBytes.length },
                    contentType,
                    fileMetadata: { fileName, fileSize, mimeType },
                    currentRelays: prevState.currentRelays,
                    totalRelays: prevState.totalRelays,
                    useWebRTC: true,
                  }))

                  try {
                    let chunkIndex = 0
                    const totalChunks = Math.ceil(contentBytes.length / ENCRYPTION_CHUNK_SIZE)

                    for (let i = 0; i < contentBytes.length; i += ENCRYPTION_CHUNK_SIZE) {
                      if (cancelledRef.current) throw new Error('Cancelled')

                      const end = Math.min(i + ENCRYPTION_CHUNK_SIZE, contentBytes.length)
                      const plainChunk = contentBytes.slice(i, end)
                      const encryptedChunk = await encryptChunk(key, plainChunk, chunkIndex)
                      await rtc.sendWithBackpressure(encryptedChunk)
                      chunkIndex++

                      setState((s) => ({
                        ...s,
                        progress: { current: end, total: contentBytes.length },
                      }))
                    }

                    rtc.send(`DONE:${totalChunks}`)
                    webRTCSuccess = true
                    resolve()
                  } catch (err) {
                    reject(err)
                  }
                },
                (data) => {
                  if (data === 'DONE_ACK') {
                    console.debug('WebRTC: Remote confirmed receipt (DONE_ACK)')
                  }
                }
              )

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
                  for (const event of existingEvents) {
                    await processSignalEvent(event)
                  }
                } catch (err) {
                  console.error('Failed to query existing signal events:', err)
                }
              }

              rtc.createDataChannel('file-transfer')
              void rtc.createOffer()
              void queryForExistingSignals()

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
                await queryForExistingSignals()
                if (!answerReceived && !webRTCSuccess) {
                  void rtc.createOffer()
                }
              }, 5000)

              connectionTimeout = setTimeout(() => {
                if (!webRTCSuccess) {
                  cleanup()
                  rtc.close()
                  reject(new Error('WebRTC connection timeout'))
                }
              }, 30000)
            })
          } catch (err) {
            if (p2pConnectionEstablished) {
              throw new Error(
                `P2P transfer failed: ${err instanceof Error ? err.message : 'Unknown error'}`
              )
            }
            console.log('P2P connection failed, falling back to cloud upload:', err)
          }
        }

        // Cloud fallback
        if (!webRTCSuccess && !p2pConnectionEstablished) {
          if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
            throw new Error('Session expired. Please start a new transfer.')
          }

          setState({
            status: 'transferring',
            message: 'Encrypting content for cloud upload...',
            contentType,
            fileMetadata: { fileName, fileSize, mimeType },
            currentRelays: client.getRelays(),
            totalRelays: DEFAULT_RELAYS.length,
          })

          const encryptedContent = await encrypt(key, contentBytes)

          if (cancelledRef.current) return

          setState((s) => ({
            ...s,
            message: 'Uploading to cloud...',
            progress: { current: 0, total: encryptedContent.length },
          }))

          const chunks = splitIntoChunks(encryptedContent, CLOUD_CHUNK_SIZE)
          const totalChunks = chunks.length
          let uploadedBytes = 0

          for (let i = 0; i < chunks.length; i++) {
            if (cancelledRef.current) return

            const chunk = chunks[i]
            setState((s) => ({
              ...s,
              message: `Uploading chunk ${i + 1}/${totalChunks}...`,
              progress: { current: uploadedBytes, total: encryptedContent.length },
            }))

            const uploadResult = await uploadToCloud(chunk, `encrypted.chunk${i}.bin`, (progress: number) => {
              const chunkUploaded = Math.round((progress / 100) * chunk.length)
              setState((s) => ({
                ...s,
                progress: { current: uploadedBytes + chunkUploaded, total: encryptedContent.length },
              }))
            })

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

            setState((s) => ({
              ...s,
              message: `Waiting for chunk ${i + 1}/${totalChunks} confirmation...`,
            }))

            const chunkAckReceived = await waitForAck(
              client,
              transferId,
              publicKey,
              receiverPubkey,
              i + 1,
              () => cancelledRef.current,
              60000
            )

            if (!chunkAckReceived) {
              throw new Error(`Timeout waiting for chunk ${i + 1} confirmation`)
            }

            uploadedBytes += chunk.length
          }
        }

        // Wait for completion ACK (seq=-1)
        const completionReceived = await waitForAck(
          client,
          transferId,
          publicKey,
          receiverPubkey,
          -1,
          () => cancelledRef.current
        )

        if (!completionReceived) {
          throw new Error('Failed to receive completion confirmation')
        }

        const successMsg = webRTCSuccess ? 'File sent via P2P!' : 'File sent successfully!'

        setState((prevState) => ({
          status: 'complete',
          message: successMsg,
          contentType,
          currentRelays: prevState.currentRelays,
          totalRelays: prevState.totalRelays,
          useWebRTC: prevState.useWebRTC,
        }))
      } catch (error) {
        if (!cancelledRef.current) {
          setPin(null)
          setState((prevState) => ({
            ...prevState,
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to send',
          }))
        }
      } finally {
        clearExpirationTimeout()
        sendingRef.current = false
        if (clientRef.current) {
          clientRef.current.close()
          clientRef.current = null
        }
      }
    },
    [clearExpirationTimeout]
  )

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, pin, send, cancel }),
    [state, pin, send, cancel]
  )
}

/**
 * Wait for ACK with specific sequence number from receiver.
 *
 * Uses subscribe-first pattern to avoid race conditions:
 * 1. Subscribe first (to catch all new events)
 * 2. Then query for existing events
 * 3. Periodic re-query as safety net for relay propagation delays
 */
function waitForAck(
  client: NostrClient,
  transferId: string,
  senderPubkey: string,
  receiverPubkey: string,
  expectedSeq: number,
  isCancelled: () => boolean,
  timeoutMs: number = 5 * 60 * 1000
): Promise<boolean> {
  if (isCancelled()) {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    let resolved = false
    let subId: string | null = null
    let reQueryInterval: ReturnType<typeof setInterval> | null = null

    const cleanup = () => {
      if (subId) {
        client.unsubscribe(subId)
        subId = null
      }
      if (reQueryInterval) {
        clearInterval(reQueryInterval)
        reQueryInterval = null
      }
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        resolve(false)
      }
    }, timeoutMs)

    const checkEvent = (event: Event): boolean => {
      const ack = parseAckEvent(event)
      if (ack && ack.transferId === transferId && ack.seq === expectedSeq) {
        return true
      }
      return false
    }

    const onFound = () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        cleanup()
        resolve(true)
      }
    }

    // 1. Subscribe FIRST to avoid race condition
    subId = client.subscribe(
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
          cleanup()
          resolve(false)
          return
        }

        if (checkEvent(event)) {
          onFound()
        }
      }
    )

    // 2. THEN query for existing events (catches events that existed before subscribe)
    const queryExisting = async () => {
      if (resolved || isCancelled()) return

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
          if (resolved) return
          if (checkEvent(event)) {
            onFound()
            return
          }
        }
      } catch (err) {
        console.error('Failed to query for existing ACK:', err)
      }
    }

    // Initial query
    void queryExisting()

    // 3. Periodic re-query as safety net for relay propagation delays
    // Re-query every 3 seconds to catch any events that may have been missed
    reQueryInterval = setInterval(() => {
      if (!resolved && !isCancelled()) {
        void queryExisting()
      }
    }, 3000)
  })
}
