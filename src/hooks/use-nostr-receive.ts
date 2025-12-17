import { useState, useCallback, useRef } from 'react'
import {
  isValidPin,
  computePinHint,
  deriveKeyFromPin,
  decrypt,
  encrypt,
  MAX_MESSAGE_SIZE,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  parsePinExchangeEvent,
  createAckEvent,
  discoverBackupRelays,
  DEFAULT_RELAYS,
  type TransferState,
  type PinExchangePayload,
  type ReceivedContent,
  EVENT_KIND_PIN_EXCHANGE,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
  createSignalingEvent,
  parseSignalingEvent,
} from '@/lib/nostr'
import { downloadFromTmpfiles } from '@/lib/tmpfiles'
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
  receive: (pin: string) => Promise<void>
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

  const receive = useCallback(async (pin: string) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return
    receivingRef.current = true
    cancelledRef.current = false
    setReceivedContent(null)

    try {
      // Validate PIN
      if (!isValidPin(pin)) {
        setState({ status: 'error', message: 'Invalid PIN format' })
        return
      }

      // Derive key from PIN
      setState({ status: 'connecting', message: 'Deriving encryption key...' })
      const pinHint = await computePinHint(pin)

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

      for (const event of events) {
        const parsed = parsePinExchangeEvent(event)
        if (!parsed) continue

        try {
          // Derive key with this salt
          const derivedKey = await deriveKeyFromPin(pin, parsed.salt)

          // Try to decrypt
          const decrypted = await decrypt(derivedKey, parsed.encryptedPayload)
          const decoder = new TextDecoder()
          const payloadStr = decoder.decode(decrypted)
          payload = JSON.parse(payloadStr) as PinExchangePayload

          transferId = parsed.transferId
          senderPubkey = event.pubkey
          key = derivedKey
          break
        } catch {
          // Decryption failed, try next event
          continue
        }
      }

      if (!payload || !transferId || !senderPubkey || !key) {
        setState({ status: 'error', message: 'Could not decrypt transfer. Wrong PIN?' })
        return
      }

      // Security check: Enforce MAX_MESSAGE_SIZE to prevent DoS/OOM
      const expectedSize = payload.fileSize || (payload.textMessage ? payload.textMessage.length : 0)
      if (expectedSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(expectedSize / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`
        })
        return
      }

      if (cancelledRef.current) return

      const isFile = payload.contentType === 'file'
      const itemType = isFile ? 'file' : 'message'

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
        message: `Receiving ${itemType}...`,
        contentType: payload.contentType,
        fileMetadata: isFile
          ? {
            fileName: payload.fileName!,
            fileSize: payload.fileSize!,
            mimeType: payload.mimeType!,
          }
          : undefined,
        useWebRTC: false,
        currentRelays: client.getRelays(),
      })

      // WebRTC result flags
      let webRTCSuccess = false
      let webRTCResult: Uint8Array | null = null

      // Try WebRTC first (if sender initiates)
      const webRTCPromise = new Promise<void>((resolve, reject) => {
        let rtc: WebRTCConnection | null = null
        let webRTCBuffer: Uint8Array[] = []
        let webRTCReceivedBytes = 0
        let settled = false

        // Timeout for WebRTC - if no offer received in 15s, fall back to tmpfiles
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true
            if (rtc) rtc.close()
            reject(new Error('WebRTC timeout'))
          }
        }, 15000)

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
              if (typeof data === 'string' && data === 'DONE') {
                // Transfer complete via WebRTC
                if (!settled) {
                  settled = true
                  clearTimeout(timeout)
                  client.unsubscribe(subId)
                  if (rtc) {
                    rtc.send('DONE_ACK')
                    rtc.close()
                  }

                  // Reconstruct from buffer
                  const totalLen = webRTCBuffer.reduce((acc, val) => acc + val.length, 0)
                  const combined = new Uint8Array(totalLen)
                  let offset = 0
                  for (const b of webRTCBuffer) {
                    combined.set(b, offset)
                    offset += b.length
                  }

                  webRTCSuccess = true
                  webRTCResult = combined
                  resolve()
                }
                return
              }

              if (data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(data)
                webRTCBuffer.push(bytes)
                webRTCReceivedBytes += bytes.length

                // Update progress
                const totalBytes = payload?.fileSize || 0
                setState(s => ({
                  ...s,
                  status: 'receiving',
                  progress: {
                    current: webRTCReceivedBytes,
                    total: totalBytes > 0 ? totalBytes : webRTCReceivedBytes
                  }
                }))
              }
            }
          )
          return rtc
        }

        // Listen for WebRTC signals from sender
        const subId = client.subscribe(
          [
            {
              kinds: [EVENT_KIND_DATA_TRANSFER],
              '#t': [transferId!],
              authors: [senderPubkey!],
            },
          ],
          async (event) => {
            if (settled) return

            const signalData = parseSignalingEvent(event)
            if (signalData && signalData.transferId === transferId) {
              try {
                const decrypted = await decrypt(key!, signalData.encryptedSignal)
                const payload = JSON.parse(new TextDecoder().decode(decrypted))
                if (payload.type === 'signal' && payload.signal) {
                  const r = initWebRTC()
                  r.handleSignal(payload.signal)
                }
              } catch (e) {
                console.error("Signal handling error", e)
              }
            }
          }
        )
      })

      // Wait for WebRTC or timeout
      try {
        await webRTCPromise
      } catch (err) {
        console.log('WebRTC not available, using tmpfiles.org download:', err)
      }

      if (cancelledRef.current) return

      // If WebRTC succeeded, use that data
      let contentData: Uint8Array

      if (webRTCSuccess && webRTCResult) {
        contentData = webRTCResult
        console.log('Received data via WebRTC')
      } else if (payload.tmpfilesUrl) {
        // Download from tmpfiles.org
        setState({
          status: 'receiving',
          message: 'Downloading encrypted data...',
          progress: { current: 0, total: payload.fileSize || 0 },
          contentType: payload.contentType,
          fileMetadata: isFile
            ? {
              fileName: payload.fileName!,
              fileSize: payload.fileSize!,
              mimeType: payload.mimeType!,
            }
            : undefined,
          currentRelays: client.getRelays(),
        })

        const encryptedData = await downloadFromTmpfiles(
          payload.tmpfilesUrl,
          (loaded, total) => {
            setState(s => ({
              ...s,
              progress: { current: loaded, total: total || payload.fileSize || loaded },
              message: `Downloading... ${total > 0 ? Math.round((loaded / total) * 100) : 0}%`,
            }))
          }
        )

        if (cancelledRef.current) return

        // Decrypt the downloaded data
        setState(s => ({ ...s, message: 'Decrypting...' }))
        contentData = await decrypt(key, encryptedData)
        console.log('Downloaded and decrypted data from tmpfiles.org')
      } else if (payload.textMessage) {
        // Inline text message (small messages embedded in payload)
        const encoder = new TextEncoder()
        contentData = encoder.encode(payload.textMessage)
        console.log('Using inline text message from payload')
      } else {
        throw new Error('No download URL or inline content available')
      }

      if (cancelledRef.current) return

      // Send completion ACK
      console.log(`Sending completion ACK (seq=-1) for transfer ${transferId}`)
      const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
      await publishWithBackup(client, completeAck)
      console.log(`✓ Completion ACK sent successfully`)

      // Set received content based on type
      if (payload.contentType === 'file') {
        setReceivedContent({
          contentType: 'file',
          data: contentData,
          fileName: payload.fileName!,
          fileSize: payload.fileSize!,
          mimeType: payload.mimeType!,
        })
        setState({
          status: 'complete',
          message: webRTCSuccess ? 'File received (P2P)!' : 'File received!',
          contentType: 'file',
          fileMetadata: {
            fileName: payload.fileName!,
            fileSize: payload.fileSize!,
            mimeType: payload.mimeType!,
          },
        })
      } else {
        const decoder = new TextDecoder()
        const message = decoder.decode(contentData)
        setReceivedContent({
          contentType: 'text',
          message,
        })
        setState({
          status: 'complete',
          message: webRTCSuccess ? 'Message received (P2P)!' : 'Message received!',
          contentType: 'text'
        })
      }
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
