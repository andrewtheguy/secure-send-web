import { useState, useCallback, useRef } from 'react'
import {
  isValidPin,
  computePinHint,
  deriveKeyFromPin,
  decrypt,
  MAX_MESSAGE_SIZE,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  parsePinExchangeEvent,
  parseChunkEvent,
  createAckEvent,
  type TransferState,
  type PinExchangePayload,
  type ReceivedContent,
  EVENT_KIND_PIN_EXCHANGE,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
} from '@/lib/nostr'

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

      // Connect to relays
      setState({ status: 'connecting', message: 'Connecting to relays...' })
      const client = createNostrClient()
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

      // Send ready ACK (seq=0)
      const readyAck = createAckEvent(secretKey, senderPubkey, transferId, 0)
      await client.publish(readyAck)

      if (cancelledRef.current) return

      // If text message was in PIN exchange payload (single chunk)
      if (payload.contentType === 'text' && payload.textMessage && payload.totalChunks <= 1) {
        // Send completion ACK
        const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
        await client.publish(completeAck)

        setReceivedContent({
          contentType: 'text',
          message: payload.textMessage,
        })
        setState({ status: 'complete', message: 'Message received!', contentType: 'text' })
        return
      }

      // Receive chunks for larger content or files
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
      })

      const chunks: Map<number, Uint8Array> = new Map()
      const totalChunks = payload.totalChunks

      await new Promise<void>((resolve, reject) => {
        let settled = false

        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          client.unsubscribe(subId)
          // Don't reject if already cancelled to avoid race condition
          if (!cancelledRef.current) {
            reject(new Error('Timeout receiving chunks'))
          }
        }, 5 * 60 * 1000) // 5 minute timeout

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
              client.unsubscribe(subId)
              reject(new Error('Cancelled'))
              return
            }

            const chunk = parseChunkEvent(event)
            if (!chunk || chunk.transferId !== transferId) return

            // Decrypt chunk
            try {
              const decryptedChunk = await decrypt(key!, chunk.data)
              chunks.set(chunk.seq, decryptedChunk)

              setState({
                status: 'receiving',
                message: `Receiving chunk ${chunks.size}/${totalChunks}...`,
                progress: { current: chunks.size, total: totalChunks },
                contentType: payload!.contentType,
                fileMetadata: isFile
                  ? {
                    fileName: payload!.fileName!,
                    fileSize: payload!.fileSize!,
                    mimeType: payload!.mimeType!,
                  }
                  : undefined,
              })

              // Check if we have all chunks
              if (chunks.size === totalChunks) {
                settled = true
                clearTimeout(timeout)
                client.unsubscribe(subId)
                resolve()
              }
            } catch (err) {
              if (settled) return
              settled = true
              clearTimeout(timeout)
              client.unsubscribe(subId)
              if (!cancelledRef.current) {
                reject(new Error(`Failed to decrypt chunk ${chunk.seq}: ${err instanceof Error ? err.message : 'Unknown error'}`))
              }
            }
          }
        )
      })

      if (cancelledRef.current) return

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
      const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
      await client.publish(completeAck)

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
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
        })
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
