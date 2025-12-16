import { useState, useCallback, useRef } from 'react'
import {
  isValidPin,
  computePinHint,
  deriveKeyFromPin,
  decrypt,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  parsePinExchangeEvent,
  parseChunkEvent,
  createAckEvent,
  type TransferState,
  type PinExchangePayload,
  EVENT_KIND_PIN_EXCHANGE,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
} from '@/lib/nostr'

export interface UseNostrReceiveReturn {
  state: TransferState
  receivedMessage: string | null
  receive: (pin: string) => Promise<void>
  cancel: () => void
  reset: () => void
}

export function useNostrReceive(): UseNostrReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' })
  const [receivedMessage, setReceivedMessage] = useState<string | null>(null)

  const clientRef = useRef<NostrClient | null>(null)
  const cancelledRef = useRef(false)

  const cancel = useCallback(() => {
    cancelledRef.current = true
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
    }
    setState({ status: 'idle' })
  }, [])

  const reset = useCallback(() => {
    cancel()
    setReceivedMessage(null)
  }, [cancel])

  const receive = useCallback(async (pin: string) => {
    cancelledRef.current = false
    setReceivedMessage(null)

    // Validate PIN
    if (!isValidPin(pin)) {
      setState({ status: 'error', message: 'Invalid PIN format' })
      return
    }

    try {
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

      if (cancelledRef.current) return

      // Generate receiver keypair
      const { secretKey } = generateEphemeralKeys()

      // Send ready ACK (seq=0)
      const readyAck = createAckEvent(secretKey, senderPubkey, transferId, 0)
      await client.publish(readyAck)

      if (cancelledRef.current) return

      // If message was in PIN exchange payload (single chunk)
      if (payload.message && payload.totalChunks <= 1) {
        // Send completion ACK
        const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
        await client.publish(completeAck)

        setReceivedMessage(payload.message)
        setState({ status: 'complete', message: 'Message received!' })
        return
      }

      // Receive chunks for larger messages
      setState({
        status: 'receiving',
        message: 'Receiving message...',
        progress: { current: 0, total: payload.totalChunks },
      })

      const chunks: Map<number, Uint8Array> = new Map()
      const totalChunks = payload.totalChunks

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          client.unsubscribe(subId)
          reject(new Error('Timeout receiving chunks'))
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
            if (cancelledRef.current) {
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
              })

              // Check if we have all chunks
              if (chunks.size === totalChunks) {
                clearTimeout(timeout)
                client.unsubscribe(subId)
                resolve()
              }
            } catch (err) {
              console.error('Failed to decrypt chunk:', err)
            }
          }
        )
      })

      if (cancelledRef.current) return

      // Reassemble message
      const sortedChunks = Array.from(chunks.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([_, data]) => data)

      const totalLength = sortedChunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of sortedChunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }

      const decoder = new TextDecoder()
      const message = decoder.decode(combined)

      // Send completion ACK
      const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
      await client.publish(completeAck)

      setReceivedMessage(message)
      setState({ status: 'complete', message: 'Message received!' })
    } catch (error) {
      if (!cancelledRef.current) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive message',
        })
      }
    }
  }, [])

  return { state, receivedMessage, receive, cancel, reset }
}
