import { useState, useCallback, useRef } from 'react'
import {
  generatePin,
  computePinHint,
  generateTransferId,
  generateSalt,
  deriveKeyFromPin,
  encrypt,
  deriveChunkNonce,
  CHUNK_SIZE,
  MAX_MESSAGE_SIZE,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  createPinExchangeEvent,
  createChunkEvent,
  parseAckEvent,
  type TransferState,
  type PinExchangePayload,
  EVENT_KIND_DATA_TRANSFER,
  type NostrClient,
} from '@/lib/nostr'

export interface UseNostrSendReturn {
  state: TransferState
  pin: string | null
  send: (message: string) => Promise<void>
  cancel: () => void
}

export function useNostrSend(): UseNostrSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' })
  const [pin, setPin] = useState<string | null>(null)

  const clientRef = useRef<NostrClient | null>(null)
  const cancelledRef = useRef(false)

  const cancel = useCallback(() => {
    cancelledRef.current = true
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
    }
    setPin(null)
    setState({ status: 'idle' })
  }, [])

  const send = useCallback(async (message: string) => {
    cancelledRef.current = false

    // Validate message size
    const encoder = new TextEncoder()
    const messageBytes = encoder.encode(message)
    if (messageBytes.length > MAX_MESSAGE_SIZE) {
      setState({ status: 'error', message: 'Message exceeds 512KB limit' })
      return
    }

    try {
      // Generate PIN and derive key
      setState({ status: 'connecting', message: 'Generating secure PIN...' })
      const newPin = generatePin()
      setPin(newPin)

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
      const totalChunks = Math.ceil(messageBytes.length / CHUNK_SIZE)

      // Create and encrypt PIN exchange payload
      const payload: PinExchangePayload = {
        message: totalChunks <= 1 ? message : '', // Include message if single chunk
        transferId,
        senderPubkey: publicKey,
        totalChunks,
      }

      const payloadBytes = encoder.encode(JSON.stringify(payload))
      const encryptedPayload = await encrypt(key, payloadBytes)

      // Publish PIN exchange event
      setState({ status: 'waiting_for_receiver', message: 'Waiting for receiver...' })
      const pinExchangeEvent = createPinExchangeEvent(secretKey, encryptedPayload, salt, transferId, pinHint)
      await client.publish(pinExchangeEvent)

      if (cancelledRef.current) return

      // Wait for receiver ready ACK (seq=0)
      const receiverPubkey = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          client.unsubscribe(subId)
          reject(new Error('Timeout waiting for receiver'))
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

      // If message fits in single chunk, we're done (it was in the PIN exchange payload)
      if (totalChunks <= 1) {
        // Wait for completion ACK
        await waitForCompletionAck(client, transferId, publicKey, receiverPubkey)
        setState({ status: 'complete', message: 'Message sent successfully!' })
        return
      }

      // Send chunks for larger messages
      setState({
        status: 'transferring',
        message: 'Sending message...',
        progress: { current: 0, total: totalChunks },
      })

      for (let i = 0; i < totalChunks; i++) {
        if (cancelledRef.current) return

        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, messageBytes.length)
        const chunkData = messageBytes.slice(start, end)

        // Encrypt chunk with derived nonce
        const nonce = deriveChunkNonce(i + 1)
        const encryptedChunk = await encrypt(key, chunkData, nonce)

        // Publish chunk event
        const chunkEvent = createChunkEvent(secretKey, transferId, i + 1, totalChunks, encryptedChunk)
        await client.publish(chunkEvent)

        setState({
          status: 'transferring',
          message: `Sending chunk ${i + 1}/${totalChunks}...`,
          progress: { current: i + 1, total: totalChunks },
        })

        // Small delay between chunks
        await new Promise((r) => setTimeout(r, 100))
      }

      // Wait for completion ACK
      await waitForCompletionAck(client, transferId, publicKey, receiverPubkey)

      setState({ status: 'complete', message: 'Message sent successfully!' })
    } catch (error) {
      if (!cancelledRef.current) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to send message',
        })
      }
    }
  }, [])

  return { state, pin, send, cancel }
}

async function waitForCompletionAck(
  client: NostrClient,
  transferId: string,
  senderPubkey: string,
  receiverPubkey: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.unsubscribe(subId)
      reject(new Error('Timeout waiting for completion'))
    }, 60000) // 1 minute timeout for completion

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
        const ack = parseAckEvent(event)
        if (ack && ack.transferId === transferId && ack.seq === -1) {
          clearTimeout(timeout)
          client.unsubscribe(subId)
          resolve()
        }
      }
    )
  })
}
