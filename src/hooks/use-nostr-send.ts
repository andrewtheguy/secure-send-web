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

  const cancel = useCallback(() => {
    cancelledRef.current = true
    sendingRef.current = false
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
    }
    setPin(null)
    setState({ status: 'idle' })
  }, [])

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
          setState({ status: 'error', message: 'File exceeds 512KB limit' })
          return
        }

        setState({ status: 'connecting', message: 'Reading file...' })
        contentBytes = await readFileAsBytes(content)
      } else {
        const encoder = new TextEncoder()
        contentBytes = encoder.encode(content)

        if (contentBytes.length > MAX_MESSAGE_SIZE) {
          setState({ status: 'error', message: 'Message exceeds 512KB limit' })
          return
        }
      }
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

      // If content fits in single chunk (text only), we're done
      if (contentType === 'text' && totalChunks <= 1) {
        await waitForCompletionAck(client, transferId, publicKey, receiverPubkey, () => cancelledRef.current)
        setState({ status: 'complete', message: 'Message sent successfully!', contentType })
        return
      }

      // Send chunks for larger content or files
      const itemType = isFile ? 'file' : 'message'
      setState({
        status: 'transferring',
        message: `Sending ${itemType}...`,
        progress: { current: 0, total: totalChunks },
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
      })

      for (let i = 0; i < totalChunks; i++) {
        if (cancelledRef.current) return

        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, contentBytes.length)
        const chunkData = contentBytes.slice(start, end)

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
          contentType,
          fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
        })

        // Small delay between chunks
        await new Promise((r) => setTimeout(r, 100))
      }

      // Wait for completion ACK
      await waitForCompletionAck(client, transferId, publicKey, receiverPubkey, () => cancelledRef.current)

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
      sendingRef.current = false
      if (clientRef.current) {
        clientRef.current.close()
        clientRef.current = null
      }
    }
  }, [])

  return { state, pin, send, cancel }
}

async function waitForCompletionAck(
  client: NostrClient,
  transferId: string,
  senderPubkey: string,
  receiverPubkey: string,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.unsubscribe(subId)
      // Don't reject if already cancelled to avoid race condition
      if (!isCancelled()) {
        reject(new Error('Timeout waiting for completion'))
      }
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
        if (isCancelled()) {
          clearTimeout(timeout)
          client.unsubscribe(subId)
          return
        }

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
