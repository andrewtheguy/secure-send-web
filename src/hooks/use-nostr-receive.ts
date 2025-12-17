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
  parseChunkNotifyEvent,
  DEFAULT_RELAYS,
  type TransferState,
  type PinExchangePayload,
  type ReceivedContent,
  type ChunkNotifyPayload,
  EVENT_KIND_PIN_EXCHANGE,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
  createSignalingEvent,
  parseSignalingEvent,
} from '@/lib/nostr'
import { downloadFromCloud, combineChunks } from '@/lib/cloud-storage'
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

      // Unified listener for both P2P and chunked cloud transfer
      // P2P is preferred, but if sender can't establish P2P, they'll send chunk notifications
      let webRTCSuccess = false
      const receivedChunks: Map<number, Uint8Array> = new Map()
      let expectedTotalChunks = payload.totalChunks || 1

      const transferResult = await new Promise<{ mode: 'p2p' | 'cloud' | 'inline'; data: Uint8Array }>((resolve, reject) => {
        let rtc: WebRTCConnection | null = null
        let webRTCBuffer: Uint8Array[] = []
        let webRTCReceivedBytes = 0
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
              if (typeof data === 'string' && data === 'DONE') {
                // Transfer complete via WebRTC
                if (!settled) {
                  settled = true
                  clearTimeout(overallTimeout)
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
                  resolve({ mode: 'p2p', data: combined })
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
          }

          expectedTotalChunks = chunkPayload.totalChunks

          setState(s => ({
            ...s,
            message: `Downloading chunk ${chunkPayload.chunkIndex + 1}/${chunkPayload.totalChunks}...`,
            useWebRTC: false,
          }))

          try {
            // Download this chunk
            const baseProgress = Array.from(receivedChunks.values()).reduce((sum, c) => sum + c.length, 0)
            const chunkData = await downloadFromCloud(
              chunkPayload.chunkUrl,
              (loaded) => {
                setState(s => ({
                  ...s,
                  progress: {
                    current: baseProgress + loaded,
                    total: payload.fileSize || (chunkPayload.totalChunks * chunkPayload.chunkSize),
                  },
                }))
              }
            )

            // Validate chunk size
            if (chunkData.length !== chunkPayload.chunkSize) {
              console.warn(`Chunk ${chunkPayload.chunkIndex} size mismatch: expected ${chunkPayload.chunkSize}, got ${chunkData.length}`)
            }

            // Store chunk
            receivedChunks.set(chunkPayload.chunkIndex, chunkData)
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
            if (receivedChunks.size === expectedTotalChunks) {
              settled = true
              clearTimeout(overallTimeout)
              client.unsubscribe(subId)

              // Combine chunks in order
              const orderedChunks: Uint8Array[] = []
              for (let i = 0; i < expectedTotalChunks; i++) {
                const chunk = receivedChunks.get(i)
                if (!chunk) {
                  reject(new Error(`Missing chunk ${i}`))
                  return
                }
                orderedChunks.push(chunk)
              }
              const combined = combineChunks(orderedChunks)
              console.log(`All ${expectedTotalChunks} chunks combined (${combined.length} bytes)`)
              resolve({ mode: 'cloud', data: combined })
            }
          } catch (err) {
            console.error(`Failed to download chunk ${chunkPayload.chunkIndex}:`, err)
            // Don't reject immediately - sender might resend
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
          async (event) => {
            if (settled) return

            // Check for WebRTC signal (only if cloud transfer hasn't started)
            if (!cloudTransferStarted) {
              const signalData = parseSignalingEvent(event)
              if (signalData && signalData.transferId === transferId) {
                try {
                  const decrypted = await decrypt(key!, signalData.encryptedSignal)
                  const signalPayload = JSON.parse(new TextDecoder().decode(decrypted))
                  if (signalPayload.type === 'signal' && signalPayload.signal) {
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
              if (!receivedChunks.has(chunkNotify.chunkIndex)) {
                await handleChunkNotify(chunkNotify)
              }
            }
          }
        )

        // Handle inline text message (no P2P or cloud needed)
        if (payload.textMessage) {
          settled = true
          clearTimeout(overallTimeout)
          client.unsubscribe(subId)
          const encoder = new TextEncoder()
          resolve({ mode: 'inline', data: encoder.encode(payload.textMessage) })
        }
      })

      if (cancelledRef.current) return

      // Process received data
      let contentData: Uint8Array

      if (transferResult.mode === 'p2p') {
        // P2P data is raw content (not encrypted)
        contentData = transferResult.data
        webRTCSuccess = true
        console.log('Received data via P2P')
      } else if (transferResult.mode === 'cloud') {
        // Cloud data is encrypted - need to decrypt
        setState(s => ({ ...s, message: 'Decrypting...' }))
        contentData = await decrypt(key, transferResult.data)
        console.log('Downloaded and decrypted data from cloud storage')
      } else {
        // Inline text message
        contentData = transferResult.data
        console.log('Using inline text message from payload')
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
