import { useState, useCallback, useRef } from 'react'
import {
  isValidPin,
  deriveKeyFromPin,
  decrypt,
  parseChunkMessage,
  decryptChunk,
  MAX_MESSAGE_SIZE,
  ENCRYPTION_CHUNK_SIZE,
} from '@/lib/crypto'
import {
  derivePeerId,
  PeerJSSignaling,
  type PeerJSMessage,
} from '@/lib/peerjs-signaling'
import type { TransferState, ReceivedContent } from '@/lib/nostr/types'

export interface UsePeerJSReceiveReturn {
  state: TransferState
  receivedContent: ReceivedContent | null
  receive: (pin: string) => Promise<void>
  cancel: () => void
  reset: () => void
}

export function usePeerJSReceive(): UsePeerJSReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' })
  const [receivedContent, setReceivedContent] = useState<ReceivedContent | null>(null)

  const peerRef = useRef<PeerJSSignaling | null>(null)
  const cancelledRef = useRef(false)
  const receivingRef = useRef(false)

  const cancel = useCallback(() => {
    cancelledRef.current = true
    receivingRef.current = false
    if (peerRef.current) {
      peerRef.current.close()
      peerRef.current = null
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

      // Derive peer ID from PIN
      setState({ status: 'connecting', message: 'Connecting to sender...' })
      const peerId = await derivePeerId(pin)

      if (cancelledRef.current) return

      // Create PeerJS instance with a random ID for receiver
      const receiverPeerId = `ss-recv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      await new Promise<void>((resolve, reject) => {
        const peer = new PeerJSSignaling(
          receiverPeerId,
          () => resolve(),
          (err) => reject(err)
        )
        peerRef.current = peer
      })

      if (cancelledRef.current) return

      // Connect to sender
      setState({ status: 'connecting', message: 'Connecting to sender...' })
      await peerRef.current!.connectToPeer(peerId, 30000)

      if (cancelledRef.current) return

      setState({ status: 'receiving', message: 'Waiting for metadata...' })

      // Wait for metadata from sender
      const metadata = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for metadata'))
        }, 30000)

        peerRef.current!.onMessage((message: PeerJSMessage) => {
          if ((message as any).type === 'metadata') {
            clearTimeout(timeout)
            resolve(message)
          }
        })
      })

      if (cancelledRef.current) return

      // Extract salt and derive key
      const salt = new Uint8Array(metadata.salt)
      const key = await deriveKeyFromPin(pin, salt)

      // Security check: Enforce MAX_MESSAGE_SIZE
      if (metadata.totalBytes > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(metadata.totalBytes / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`
        })
        return
      }

      const isFile = metadata.contentType === 'file'

      setState({
        status: 'receiving',
        message: `Receiving ${isFile ? 'file' : 'message'}...`,
        contentType: metadata.contentType,
        fileMetadata: isFile ? {
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
        } : undefined,
        useWebRTC: true,
      })

      // Send ready acknowledgment
      peerRef.current!.send({ type: 'ready' })

      // Check if small text was included in metadata
      if (metadata.encryptedPayload) {
        // Decrypt the inline text
        const encryptedBytes = Uint8Array.from(atob(metadata.encryptedPayload), c => c.charCodeAt(0))
        const decryptedBytes = await decrypt(key, encryptedBytes)
        const message = new TextDecoder().decode(decryptedBytes)

        // Wait for done signal
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Timeout waiting for completion signal'))
          }, 30000)

          peerRef.current!.onMessage((msg: PeerJSMessage) => {
            if (msg.type === 'done') {
              clearTimeout(timeout)
              resolve()
            }
          })
        })

        // Send done_ack
        peerRef.current!.send({ type: 'done_ack' })

        setReceivedContent({
          contentType: 'text',
          message,
        })
        setState({ status: 'complete', message: 'Message received (P2P)!', contentType: 'text' })
        return
      }

      // Receive and decrypt file/large text data
      let contentData = new Uint8Array(metadata.totalBytes)
      let totalDecryptedBytes = 0
      const receivedChunkIndices = new Set<number>()

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Transfer timeout'))
        }, 10 * 60 * 1000) // 10 minutes

        peerRef.current!.onMessage(async (message: PeerJSMessage) => {
          if (cancelledRef.current) {
            clearTimeout(timeout)
            reject(new Error('Cancelled'))
            return
          }

          if (message.type === 'chunk' && message.data) {
            try {
              // Parse and decrypt chunk
              const encryptedChunk = new Uint8Array(message.data as ArrayBuffer)
              const { chunkIndex, encryptedData } = parseChunkMessage(encryptedChunk)
              const decryptedChunk = await decryptChunk(key, encryptedData)

              // Calculate write position based on chunk index
              const writePosition = chunkIndex * ENCRYPTION_CHUNK_SIZE

              // Ensure buffer is large enough
              const requiredSize = writePosition + decryptedChunk.length
              if (contentData.length < requiredSize) {
                const newBuffer = new Uint8Array(Math.max(requiredSize, contentData.length * 2))
                newBuffer.set(contentData)
                contentData = newBuffer
              }

              // Write directly to position in buffer
              contentData.set(decryptedChunk, writePosition)
              receivedChunkIndices.add(chunkIndex)
              totalDecryptedBytes += decryptedChunk.length

              setState(s => ({
                ...s,
                progress: {
                  current: totalDecryptedBytes,
                  total: metadata.totalBytes,
                },
              }))
            } catch (err) {
              console.error('Failed to decrypt chunk:', err)
            }
          } else if (message.type === 'done') {
            clearTimeout(timeout)
            resolve()
          }
        })
      })

      if (cancelledRef.current) return

      // Trim buffer to actual content size
      contentData = contentData.slice(0, totalDecryptedBytes)

      // Send done_ack
      peerRef.current!.send({ type: 'done_ack' })

      // Set received content
      if (metadata.contentType === 'file') {
        setReceivedContent({
          contentType: 'file',
          data: contentData,
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
        })
        setState({
          status: 'complete',
          message: 'File received (P2P)!',
          contentType: 'file',
          fileMetadata: {
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            mimeType: metadata.mimeType,
          },
        })
      } else {
        const message = new TextDecoder().decode(contentData)
        setReceivedContent({
          contentType: 'text',
          message,
        })
        setState({
          status: 'complete',
          message: 'Message received (P2P)!',
          contentType: 'text',
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
      receivingRef.current = false
      if (peerRef.current) {
        peerRef.current.close()
        peerRef.current = null
      }
    }
  }, [])

  return { state, receivedContent, receive, cancel, reset }
}
