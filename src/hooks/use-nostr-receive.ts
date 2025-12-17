import { useState, useCallback, useRef } from 'react'
import {
  isValidPin,
  computePinHint,
  deriveKeyFromPin,
  decrypt,
  encrypt,
  MAX_MESSAGE_SIZE,
  CHUNK_SIZE,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  parsePinExchangeEvent,
  parseChunkEvent,
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
import type { Event } from 'nostr-tools'
import { WebRTCConnection } from '@/lib/webrtc'

// ACK delay constant
const RELAY_ACK_DELAY_MS = 1000 // 1 second delay before sending ACK

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

      // Use ALL seed relays for PIN exchange query (maximum discoverability)
      setState({ status: 'connecting', message: 'Connecting to relays...' })
      let client = createNostrClient([...DEFAULT_RELAYS])
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
      const expectedSize = payload.fileSize || (payload.textMessage ? payload.textMessage.length : payload.totalChunks * 16384)
      if (expectedSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(expectedSize / 1024)}KB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`
        })
        return
      }

      if (cancelledRef.current) return

      const isFile = payload.contentType === 'file'
      const itemType = isFile ? 'file' : 'message'

      // Generate receiver keypair
      const { secretKey } = generateEphemeralKeys()

      // Send ready ACK (seq=0) on seed relays
      console.log(`Sending ready ACK (seq=0) for transfer ${transferId}`)
      const readyAck = createAckEvent(secretKey, senderPubkey, transferId, 0)
      await publishWithBackup(client, readyAck)
      console.log(`✓ Ready ACK sent successfully`)

      if (cancelledRef.current) return

      // Switch to sender's preferred relays for data transfer (if provided)
      if (payload.relays && payload.relays.length > 0) {
        client.close()
        client = createNostrClient(payload.relays)
        clientRef.current = client
        // Wait for new connections to be ready
        await client.waitForConnection()
      }

      if (cancelledRef.current) return

      // If text message was in PIN exchange payload (single chunk)
      if (payload.contentType === 'text' && payload.textMessage && payload.totalChunks <= 1) {
        // Send completion ACK
        console.log(`Sending completion ACK (seq=-1) for single-chunk transfer ${transferId}`)
        const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
        await publishWithBackup(client, completeAck)
        console.log(`✓ Completion ACK sent successfully`)

        setReceivedContent({
          contentType: 'text',
          message: payload.textMessage,
        })
        setState({ status: 'complete', message: 'Message received!', contentType: 'text' })
        return
      }

      // Receive chunks for larger content or files
      const chunks: Map<number, Uint8Array> = new Map()
      const totalChunks = payload.totalChunks

      // Initialize chunk tracking
      const chunkStates = new Map<number, { seq: number; status: 'pending' | 'receiving' | 'received'; timestamp?: number }>()
      for (let i = 0; i < totalChunks; i++) {
        chunkStates.set(i, { seq: i, status: 'pending' })
      }

      setState({
        status: 'receiving',
        message: `Receiving ${itemType}...`,
        progress: { current: 0, total: payload.totalChunks },
        contentType: payload.contentType,
        fileMetadata: isFile
          ? {
            fileName: payload.fileName!,
            fileSize: payload.fileSize!,
            mimeType: payload.mimeType!,
          }
          : undefined,
        chunks: chunkStates,
        useWebRTC: false,
        currentRelays: client.getRelays(),
      })

      // WebRTC result flags (outer scope)
      let webRTCSuccess = false
      let webRTCResult: Uint8Array | null = null

      // ACK interval - keeps sending ACK for last received chunk until next arrives
      let lastAckedSeq = -1
      let ackIntervalId: ReturnType<typeof setInterval> | null = null

      // Query for missed chunks - checks relays for any chunk events we might have missed
      const queryMissedChunks = async () => {
        console.log(`🔍 Querying relays for missed chunks (have ${chunks.size}/${totalChunks})`)
        try {
          const events = await client.query([
            {
              kinds: [EVENT_KIND_DATA_TRANSFER],
              '#t': [transferId!],
              authors: [senderPubkey!],
              limit: 100,
            },
          ])

          let foundMissed = 0
          for (const event of events) {
            const chunk = parseChunkEvent(event)
            if (!chunk || chunk.transferId !== transferId) continue
            if (chunks.has(chunk.seq)) continue // Already have this chunk

            // Found a missed chunk! Process it
            console.log(`🔍 Found missed chunk ${chunk.seq} via query`)
            foundMissed++

            try {
              // Mark chunk as receiving
              chunkStates.set(chunk.seq, { seq: chunk.seq, status: 'receiving', timestamp: Date.now() })

              const decryptedChunk = await decrypt(key!, chunk.data)
              chunks.set(chunk.seq, decryptedChunk)

              // Mark chunk as received
              chunkStates.set(chunk.seq, { seq: chunk.seq, status: 'received', timestamp: Date.now() })

              // If this is a newer chunk than what we're ACKing, update the ACK
              if (chunk.seq > lastAckedSeq) {
                console.log(`🔍 Updating ACK from ${lastAckedSeq} to ${chunk.seq}`)
                await startAckInterval(chunk.seq)
              }
            } catch (err) {
              console.error(`🔍 Failed to decrypt missed chunk ${chunk.seq}:`, err)
            }
          }

          if (foundMissed > 0) {
            console.log(`🔍 Recovered ${foundMissed} missed chunk(s)`)
          } else {
            console.log(`🔍 No missed chunks found in query`)
          }
        } catch (err) {
          console.error(`🔍 Failed to query for missed chunks:`, err)
        }
      }

      const startAckInterval = async (seq: number) => {
        // Clear previous interval
        if (ackIntervalId) {
          clearInterval(ackIntervalId)
          ackIntervalId = null
        }

        lastAckedSeq = seq

        // Sleep 1 second before sending ACK
        await new Promise(resolve => setTimeout(resolve, RELAY_ACK_DELAY_MS))

        // Send ACK
        console.log(`Sending ACK for chunk ${seq} (retry counter reset)`)
        const ackEvent = createAckEvent(secretKey, senderPubkey!, transferId!, seq)
        try {
          await publishWithBackup(client, ackEvent)
          console.log(`✓ ACK sent for chunk ${seq}`)
        } catch (err) {
          console.error(`✗ Failed to send initial ACK for chunk ${seq}:`, err)
          // Continue - interval will retry
        }

        // Keep sending ACK every 2 seconds until stopped (max 50 retries)
        // These counters are fresh for each chunk (reset when startAckInterval is called)
        let consecutiveFailures = 0
        let resendCount = 0
        const maxResends = 50
        const queryInterval = 10 // Query for missed chunks every 10 retries
        ackIntervalId = setInterval(async () => {
          if (cancelledRef.current) {
            if (ackIntervalId) clearInterval(ackIntervalId)
            return
          }

          // Stop after max retries
          if (resendCount >= maxResends) {
            console.warn(`⚠️ Stopped resending ACK for chunk ${lastAckedSeq} after ${maxResends} attempts`)
            if (ackIntervalId) {
              clearInterval(ackIntervalId)
              ackIntervalId = null
            }
            return
          }

          resendCount++

          // Query for missed chunks periodically (every 10 retries = 20 seconds)
          if (resendCount % queryInterval === 0) {
            await queryMissedChunks()
          }

          try {
            const ackEvent = createAckEvent(secretKey, senderPubkey!, transferId!, lastAckedSeq)
            await publishWithBackup(client, ackEvent)
            console.log(`✓ ACK resent for chunk ${lastAckedSeq} (${resendCount}/${maxResends})`)
            consecutiveFailures = 0 // Reset on success
          } catch (err) {
            consecutiveFailures++
            console.error(`✗ Failed to publish ACK for chunk ${lastAckedSeq} (failure ${consecutiveFailures}, attempt ${resendCount}/${maxResends}):`, err)
            // Don't clear interval - transient network issues may resolve
            // But warn if failures persist
            if (consecutiveFailures >= 5) {
              console.warn(`⚠️ ${consecutiveFailures} consecutive ACK send failures for chunk ${lastAckedSeq}`)
            }
          }
        }, 2000)
      }

      const stopAckInterval = () => {
        if (ackIntervalId) {
          clearInterval(ackIntervalId)
          ackIntervalId = null
        }
      }

      // WebRTC State
      let rtc: WebRTCConnection | null = null
      let webRTCBuffer: Uint8Array[] = []
      let webRTCReceivedBytes = 0

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const chunkFailures: Map<number, number> = new Map() // Track decrypt failures per chunk
        const maxFailuresPerChunk = 3

        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          stopAckInterval()
          client.unsubscribe(subId)
          if (rtc) rtc.close()
          if (!cancelledRef.current) {
            reject(new Error('Timeout receiving chunks'))
          }
        }, 10 * 60 * 1000) // 10 minute timeout

        // Initialize WebRTC (lazy init on first signal offer)
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
              setState(s => ({ ...s, message: 'Receiving via P2P...' }))
            },
            (data) => {
              if (typeof data === 'string' && data === 'DONE') {
                // Transfer complete via WebRTC
                settled = true
                clearTimeout(timeout)
                stopAckInterval()
                client.unsubscribe(subId)
                if (rtc) {
                  rtc.send('DONE_ACK')
                  rtc.close()
                }

                // Reconstruct from webRTCBuffer
                const totalLen = webRTCBuffer.reduce((acc, val) => acc + val.length, 0)
                const combined = new Uint8Array(totalLen)
                let offset = 0
                for (const b of webRTCBuffer) {
                  combined.set(b, offset)
                  offset += b.length
                }

                // Manually populate chunks map for "validation" pass below?
                // Or just bypass validation loop if webRTC success.
                // The Promise resolves void, validation loop is AFTER promise.

                // WE NEED TO PASS DATA OUT
                // Hack: populate the 'chunks' map with a single "full" chunk or modify logic
                // Actually, the logic AFTER this promise block assumes 'chunks' map is populated.
                // Let's populate 'chunks' map with pseudo-chunks or just modify the logic after.

                // Better: We can store the final buffer in a variable accessible outside.
                // But for minimal collision with existing logic:
                // We can fill logic to return early if we have full buffer.

                // Let's modify the resolve to pass back the buffer if WebRTC used?
                // The promise signature is Promise<void>.
                // Let's set a flag "receivedViaWebRTC" and store buffer in "chunks"?
                // "chunks" is Map<number, Uint8Array>.
                // If we received via WebRTC, we might have contiguous data.
                // We can fake it as chunk 0 = full data, and totalChunks = 1?
                // But payload.totalChunks is fixed.

                // Let's use a workaround:
                // Store the full data in chunks map as if we received all chunks?
                // No, that's hard to map back to indices.

                // Best: Set a "successViaWebRTC" flag in outer scope.
                webRTCSuccess = true // Define this outside
                webRTCResult = combined // Define this outside
                resolve()
                return
              }

              if (data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(data)
                webRTCBuffer.push(bytes)
                webRTCReceivedBytes += bytes.length

                // Update progress
                const totalBytes = payload?.fileSize || (payload?.totalChunks || 0) * CHUNK_SIZE

                setState(s => ({
                  ...s,
                  status: 'receiving',
                  progress: {
                    current: webRTCReceivedBytes,
                    total: totalBytes > 0 ? totalBytes : webRTCReceivedBytes // avoid 0 total
                  }
                }))
              }
            }
          )
          return rtc
        }

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

            if (cancelledRef.current) {
              settled = true
              clearTimeout(timeout)
              stopAckInterval()
              client.unsubscribe(subId)
              if (rtc) rtc.close()
              reject(new Error('Cancelled'))
              return
            }

            // Check for Signal
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
              return
            }

            const chunk = parseChunkEvent(event)
            if (!chunk || chunk.transferId !== transferId) return

            // Decrypt chunk
            try {
              if (chunks.has(chunk.seq)) {
                // Already have this chunk, but only re-ACK if it's not older than current
                if (chunk.seq >= lastAckedSeq) {
                  console.log(`Duplicate chunk ${chunk.seq}, re-sending ACK`)
                  await startAckInterval(chunk.seq)
                } else {
                  console.log(`Ignoring duplicate chunk ${chunk.seq}, already at ${lastAckedSeq}`)
                }
                return
              }

              // Mark chunk as receiving
              chunkStates.set(chunk.seq, { seq: chunk.seq, status: 'receiving', timestamp: Date.now() })

              const decryptedChunk = await decrypt(key!, chunk.data)
              chunks.set(chunk.seq, decryptedChunk)
              chunkFailures.delete(chunk.seq) // Clear any previous failures on success

              // Mark chunk as received
              chunkStates.set(chunk.seq, { seq: chunk.seq, status: 'received', timestamp: Date.now() })

              const totalBytes = payload?.fileSize || (payload?.totalChunks || 0) * CHUNK_SIZE
              const currentBytes = chunks.size * CHUNK_SIZE
              // Clamping current to total for cosmetic correctness if estimation vs actual differs
              const displayCurrent = totalBytes > 0 && currentBytes > totalBytes ? totalBytes : currentBytes

              setState({
                status: 'receiving',
                message: `Receiving chunk ${chunks.size}/${totalChunks}...`,
                progress: {
                  current: displayCurrent,
                  total: totalBytes
                },
                contentType: payload?.contentType,
                fileMetadata: isFile
                  ? {
                    fileName: payload?.fileName!,
                    fileSize: payload?.fileSize!,
                    mimeType: payload?.mimeType!,
                  }
                  : undefined,
                chunks: chunkStates,
                currentRelays: client.getRelays(),
              })

              // Send ACK for this chunk (and keep sending until next arrives)
              await startAckInterval(chunk.seq)

              // Check if we have all chunks
              if (chunks.size === totalChunks) {
                settled = true
                clearTimeout(timeout)
                stopAckInterval()
                client.unsubscribe(subId)
                if (rtc) rtc.close()
                resolve()
              }
            } catch (err) {
              if (settled) return

              // Track failures per chunk
              const failures = (chunkFailures.get(chunk.seq) || 0) + 1
              chunkFailures.set(chunk.seq, failures)
              console.error(`Failed to decrypt chunk ${chunk.seq} (attempt ${failures}/${maxFailuresPerChunk}):`, err)

              // Reject after max failures for same chunk
              if (failures >= maxFailuresPerChunk) {
                settled = true
                clearTimeout(timeout)
                stopAckInterval()
                client.unsubscribe(subId)
                if (rtc) rtc.close()
                reject(new Error(`Failed to decrypt chunk ${chunk.seq} after ${maxFailuresPerChunk} attempts`))
              }
            }
          }
        )
      })

      if (cancelledRef.current) return

      // If WebRTC success, use that result
      if (webRTCSuccess && webRTCResult) {
        // Skip chunk validation and reassembly
        // Send final ACK via relay just in case (already sent via WebRTC but backup is good)
        console.log(`Sending completion ACK (seq=-1) after WebRTC transfer ${transferId}`)
        const completeAck = createAckEvent(secretKey, senderPubkey!, transferId!, -1)
        await publishWithBackup(client, completeAck)
        console.log(`✓ Completion ACK sent successfully`)

        if (payload.contentType === 'file') {
          setReceivedContent({
            contentType: 'file',
            data: webRTCResult,
            fileName: payload.fileName!,
            fileSize: payload.fileSize!,
            mimeType: payload.mimeType!,
          })
          setState({
            status: 'complete',
            message: 'File received (P2P)!',
            contentType: 'file',
            fileMetadata: {
              fileName: payload.fileName!,
              fileSize: payload.fileSize!,
              mimeType: payload.mimeType!,
            },
          })
        } else {
          const decoder = new TextDecoder()
          const message = decoder.decode(webRTCResult)
          setReceivedContent({
            contentType: 'text',
            message,
          })
          setState({ status: 'complete', message: 'Message received (P2P)!', contentType: 'text' })
        }
        return
      }

      // Validate all chunks are present (contiguous 0..totalChunks-1)
      for (let i = 0; i < totalChunks; i++) {
        if (!chunks.has(i)) {
          throw new Error(`Missing chunk ${i} of ${totalChunks}`)
        }
      }

      // Reassemble content (chunks are validated to be contiguous 0..totalChunks-1)
      const sortedChunks: Uint8Array[] = []
      for (let i = 0; i < totalChunks; i++) {
        sortedChunks.push(chunks.get(i)!)
      }

      const totalLength = sortedChunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of sortedChunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }

      // Send completion ACK
      console.log(`Sending completion ACK (seq=-1) after relay transfer ${transferId}`)
      const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
      await publishWithBackup(client, completeAck)
      console.log(`✓ Completion ACK sent successfully`)

      // Set received content based on type
      if (payload.contentType === 'file') {
        setReceivedContent({
          contentType: 'file',
          data: combined,
          fileName: payload.fileName!,
          fileSize: payload.fileSize!,
          mimeType: payload.mimeType!,
        })
        setState({
          status: 'complete',
          message: 'File received!',
          contentType: 'file',
          fileMetadata: {
            fileName: payload.fileName!,
            fileSize: payload.fileSize!,
            mimeType: payload.mimeType!,
          },
        })
      } else {
        const decoder = new TextDecoder()
        const message = decoder.decode(combined)
        setReceivedContent({
          contentType: 'text',
          message,
        })
        setState({ status: 'complete', message: 'Message received!', contentType: 'text' })
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
