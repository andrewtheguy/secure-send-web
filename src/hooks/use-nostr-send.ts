import { useState, useCallback, useRef } from 'react'

// Rate limiting configuration
const THROTTLE_CHUNK_INTERVAL = 64 // ~1MB given 16KB chunks
const THROTTLE_PAUSE_MS = 3000
import {
  generatePin,
  computePinHint,
  generateTransferId,
  generateSalt,
  deriveKeyFromPin,
  encrypt,
  CHUNK_SIZE,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  createPinExchangeEvent,
  createChunkEvent,
  parseAckEvent,
  parseRetryRequestEvent,
  type TransferState,
  type PinExchangePayload,
  type ContentType,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
} from '@/lib/nostr'
import { readFileAsBytes } from '@/lib/file-utils'

export interface UseNostrSendReturn {
  state: TransferState
  pin: string | null
  send: (content: string | File) => Promise<void>
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

  const send = useCallback(async (content: string | File) => {
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
          const limitKB = MAX_MESSAGE_SIZE / 1024
          setState({ status: 'error', message: `File exceeds ${limitKB}KB limit` })
          return
        }

        setState({ status: 'connecting', message: 'Reading file...' })
        contentBytes = await readFileAsBytes(content)
      } else {
        const encoder = new TextEncoder()
        contentBytes = encoder.encode(content)

        if (contentBytes.length > MAX_MESSAGE_SIZE) {
          const limitKB = MAX_MESSAGE_SIZE / 1024
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

      // Connect to relays
      setState({ status: 'connecting', message: 'Connecting to relays...' })
      const client = createNostrClient()
      clientRef.current = client

      if (cancelledRef.current) return

      // Calculate chunks
      const totalChunks = Math.ceil(contentBytes.length / CHUNK_SIZE)

      // Create and encrypt PIN exchange payload
      const payload: PinExchangePayload = {
        contentType,
        transferId,
        senderPubkey: publicKey,
        totalChunks,
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
      })
      const pinExchangeEvent = createPinExchangeEvent(secretKey, encryptedPayload, salt, transferId, pinHint)
      await client.publish(pinExchangeEvent)

      if (cancelledRef.current) return

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

      // Enforce TTL: reject if session has expired
      if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
        throw new Error('Session expired. Please start a new transfer.')
      }

      // Set up retry queue and processing - BEFORE starting chunk transfer
      const retryQueue: Set<number> = new Set()
      let isProcessingRetries = false
      let completionAckReceived = false
      let retrySubId: string | null = null

      const processRetryChunks = async () => {
        if (isProcessingRetries || retryQueue.size === 0 || cancelledRef.current) return
        isProcessingRetries = true

        const chunksToRetry = Array.from(retryQueue)
        retryQueue.clear()

        setState(prev => ({
          ...prev,
          message: `Resending ${chunksToRetry.length} missing chunks...`,
        }))

        for (const seq of chunksToRetry) {
          if (cancelledRef.current) break
          if (seq < 0 || seq * CHUNK_SIZE >= contentBytes.length) continue

          try {
            const start = seq * CHUNK_SIZE
            const end = Math.min(start + CHUNK_SIZE, contentBytes.length)
            const chunkData = contentBytes.slice(start, end)
            const encryptedChunk = await encrypt(key, chunkData)
            const chunkEvent = createChunkEvent(secretKey, transferId, seq, totalChunks, encryptedChunk)
            await client.publish(chunkEvent)
            console.log(`Resent chunk ${seq}`)
          } catch (err) {
            console.error(`Failed to resend chunk ${seq}`, err)
            // Re-add to queue for another attempt
            retryQueue.add(seq)
          }
        }

        isProcessingRetries = false
      }

      // Start listening for retry events and completion ACK EARLY
      retrySubId = client.subscribe(
        [
          {
            kinds: [EVENT_KIND_DATA_TRANSFER],
            '#t': [transferId],
            '#p': [publicKey],
            authors: [receiverPubkey],
          },
        ],
        async (event) => {
          if (cancelledRef.current) return

          // Check for completion ACK
          const ack = parseAckEvent(event)
          if (ack && ack.transferId === transferId && ack.seq === -1) {
            completionAckReceived = true
            return
          }

          // Check for Retry Request
          const retry = parseRetryRequestEvent(event)
          if (retry && retry.transferId === transferId) {
            console.log(`Received retry request for ${retry.missingSeqs.length} chunks: ${retry.missingSeqs.slice(0, 5).join(', ')}${retry.missingSeqs.length > 5 ? '...' : ''}`)
            retry.missingSeqs.forEach(seq => retryQueue.add(seq))
            // Process retries immediately (non-blocking)
            processRetryChunks()
          }
        }
      )

      // Query for any retry events we might have missed
      const existingRetryEvents = await client.query([
        {
          kinds: [EVENT_KIND_DATA_TRANSFER],
          '#t': [transferId],
          '#p': [publicKey],
          authors: [receiverPubkey],
        },
      ])

      for (const event of existingRetryEvents) {
        const retry = parseRetryRequestEvent(event)
        if (retry && retry.transferId === transferId) {
          retry.missingSeqs.forEach(seq => retryQueue.add(seq))
        }
      }

      // If content fits in single chunk (text only), we're done
      if (contentType === 'text' && totalChunks <= 1) {
        await waitForCompletionAckOnly(
          () => completionAckReceived,
          () => cancelledRef.current
        )
        if (retrySubId) client.unsubscribe(retrySubId)
        setState({ status: 'complete', message: 'Message sent successfully!', contentType })
        return
      }

      // Send chunks one by one
      for (let i = 0; i < totalChunks; i++) {
        if (cancelledRef.current) return

        // Process any pending retries
        if (retryQueue.size > 0) {
          await processRetryChunks()
        }

        // Pause to avoid overwhelming relays
        if (i > 0 && i % THROTTLE_CHUNK_INTERVAL === 0) {
          setState({
            status: 'transferring',
            message: 'Pausing for network stability...',
            progress: { current: i, total: totalChunks },
            contentType,
            fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
          })
          await new Promise(resolve => setTimeout(resolve, THROTTLE_PAUSE_MS))
          if (cancelledRef.current) return
        }

        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, contentBytes.length)
        const chunkData = contentBytes.slice(start, end)
        const encryptedChunk = await encrypt(key, chunkData)

        if (cancelledRef.current) return

        const chunkEvent = createChunkEvent(secretKey, transferId, i, totalChunks, encryptedChunk)
        await client.publish(chunkEvent)

        setState({
          status: 'transferring',
          message: `Sending chunk ${i + 1}/${totalChunks}...`,
          progress: { current: i + 1, total: totalChunks },
          contentType,
          fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
        })
      }

      // Process any remaining retries
      await processRetryChunks()

      // Wait for completion ACK (retry handling is already active via subscription)
      await waitForCompletionAckOnly(
        () => completionAckReceived,
        () => cancelledRef.current
      )

      // Cleanup retry subscription
      if (retrySubId) client.unsubscribe(retrySubId)

      const successMsg = isFile ? 'File sent successfully!' : 'Message sent successfully!'
      setState({ status: 'complete', message: successMsg, contentType })
    } catch (error) {
      if (!cancelledRef.current) {
        setPin(null)
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to send',
        })
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
 * Wait for completion ACK by polling a flag set by the subscription callback.
 * The actual event listening is handled by an earlier subscription.
 */
async function waitForCompletionAckOnly(
  isComplete: () => boolean,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!isCancelled()) {
        reject(new Error('Timeout waiting for completion'))
      }
    }, 60 * 60 * 1000) // 1 hour timeout for completion

    // Poll for completion flag every 500ms
    const checkInterval = setInterval(() => {
      if (isCancelled()) {
        clearInterval(checkInterval)
        clearTimeout(timeout)
        resolve()
        return
      }

      if (isComplete()) {
        clearInterval(checkInterval)
        clearTimeout(timeout)
        resolve()
      }
    }, 500)
  })
}
