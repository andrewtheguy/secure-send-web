import { useState, useCallback, useRef } from 'react'
import {
  generatePin,
  computePinHint,
  generateTransferId,
  generateSalt,
  deriveKeyFromPin,
  encrypt,
  decrypt,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  createPinExchangeEvent,
  parseAckEvent,
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
import { uploadToCloud } from '@/lib/cloud-storage'
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

      if (isFile) {
        fileName = content.name
        fileSize = content.size
        mimeType = content.type || 'application/octet-stream'

        if (content.size > MAX_MESSAGE_SIZE) {
          const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024
          setState({ status: 'error', message: `File exceeds ${limitMB}MB limit` })
          return
        }

        setState({ status: 'connecting', message: 'Reading file...' })
        contentBytes = await readFileAsBytes(content)
      } else {
        const encoder = new TextEncoder()
        contentBytes = encoder.encode(content)

        if (contentBytes.length > MAX_MESSAGE_SIZE) {
          const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024
          setState({ status: 'error', message: `Message exceeds ${limitMB}MB limit` })
          return
        }
      }

      // Generate PIN and derive key
      setState({ status: 'connecting', message: 'Generating secure PIN...' })
      const newPin = generatePin()
      const sessionStartTime = Date.now()
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

      const [pinHint, salt] = await Promise.all([computePinHint(newPin), Promise.resolve(generateSalt())])
      const key = await deriveKeyFromPin(newPin, salt)

      if (cancelledRef.current) return

      // Generate ephemeral keypair
      const { secretKey, publicKey } = generateEphemeralKeys()
      const transferId = generateTransferId()

      if (cancelledRef.current) return

      // Encrypt entire content
      setState({ status: 'connecting', message: 'Encrypting content...' })
      const encryptedContent = await encrypt(key, contentBytes)

      if (cancelledRef.current) return

      // Upload encrypted content to cloud storage
      setState({
        status: 'transferring',
        message: 'Uploading encrypted data...',
        progress: { current: 0, total: encryptedContent.length },
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
      })

      const uploadResult = await uploadToCloud(
        encryptedContent,
        'encrypted.bin',
        (progress: number) => {
          const uploaded = Math.round((progress / 100) * encryptedContent.length)
          setState(s => ({
            ...s,
            progress: { current: uploaded, total: encryptedContent.length },
            message: `Uploading... ${progress}%`,
          }))
        }
      )

      if (cancelledRef.current) return

      // Create Nostr client for signaling
      const client = createNostrClient([...DEFAULT_RELAYS])
      clientRef.current = client

      // Create PIN exchange payload with cloud storage URL
      const payload: PinExchangePayload = {
        contentType,
        transferId,
        senderPubkey: publicKey,
        totalChunks: 1, // Backwards compat
        relays: [...DEFAULT_RELAYS],
        tmpfilesUrl: uploadResult.url,
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
      if (!options?.relayOnly) {
        try {
          setState({ status: 'connecting', message: 'Attempting P2P connection...' })

          await new Promise<void>((resolve, reject) => {
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
                // DataChannel open
                console.log('WebRTC connected, sending data...')
                setState({
                  status: 'transferring',
                  message: 'Sending via P2P...',
                  progress: { current: 0, total: contentBytes.length },
                  contentType,
                  fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
                })

                try {
                  // Send file content in chunks
                  const chunkSize = 16384 // 16KB chunks for data channel
                  for (let i = 0; i < contentBytes.length; i += chunkSize) {
                    if (cancelledRef.current) throw new Error('Cancelled')
                    const end = Math.min(i + chunkSize, contentBytes.length)
                    rtc.send(contentBytes.slice(i, end))

                    // Update progress
                    setState(s => ({
                      ...s,
                      progress: { current: end, total: contentBytes.length },
                    }))
                  }

                  // Send "DONE" message
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
                const signalData = parseSignalingEvent(event)
                if (signalData && signalData.transferId === transferId) {
                  try {
                    const decrypted = await decrypt(key, signalData.encryptedSignal)
                    const payload = JSON.parse(new TextDecoder().decode(decrypted))
                    if (payload.type === 'signal' && payload.signal) {
                      rtc.handleSignal(payload.signal)
                    }
                  } catch (err) {
                    console.error('Failed to process signaling event:', err)
                  }
                }
              }
            )

            // Initiate WebRTC
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
          console.log('WebRTC failed, receiver will use cloud storage download:', err)
          // Not a failure - receiver can still download from cloud storage
        }
      }

      // Update status while waiting for completion
      if (!webRTCSuccess) {
        setState({
          status: 'transferring',
          message: 'Receiver is downloading...',
          contentType,
          fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
          currentRelays: client.getRelays(),
        })
      }

      // Wait for completion ACK (seq=-1)
      const completionReceived = await waitForAck(client, transferId, publicKey, receiverPubkey, -1, () => cancelledRef.current)

      if (!completionReceived) {
        throw new Error('Failed to receive completion confirmation')
      }

      const successMsg = webRTCSuccess
        ? (isFile ? 'File sent via P2P!' : 'Message sent via P2P!')
        : (isFile ? 'File sent successfully!' : 'Message sent successfully!')

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
