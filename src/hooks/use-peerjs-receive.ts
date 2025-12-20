import { useState, useCallback, useRef } from 'react'
import {
  parseChunkMessage,
  decryptChunk,
  MAX_MESSAGE_SIZE,
  ENCRYPTION_CHUNK_SIZE,
  TRANSFER_EXPIRATION_MS,
  deriveKeyFromPinKey,
} from '@/lib/crypto'
import {
  PeerJSSignaling,
  type PeerJSMessage,
} from '@/lib/peerjs-signaling'
import type { TransferState } from '@/lib/nostr/types'
import type { PinKeyMaterial, ReceivedContent } from '@/lib/types'

export interface UsePeerJSReceiveReturn {
  state: TransferState
  receivedContent: ReceivedContent | null
  receive: (pinMaterial: PinKeyMaterial) => Promise<void>
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

  const receive = useCallback(async (pinMaterial: PinKeyMaterial) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return
    receivingRef.current = true
    cancelledRef.current = false
    setReceivedContent(null)

    try {
      if (!pinMaterial?.key || !pinMaterial?.hint) {
        setState({ status: 'error', message: 'PIN unavailable. Please re-enter.' })
        return
      }

      // Derive peer ID from PIN
      setState({ status: 'connecting', message: 'Connecting to sender...' })
      const peerId = `ss-${pinMaterial.hint}`

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
      const metadata = await new Promise<Extract<PeerJSMessage, { type: 'metadata' }>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for metadata'))
        }, 30000)

        peerRef.current!.onMessage((message: PeerJSMessage) => {
          if (message.type === 'metadata') {
            clearTimeout(timeout)
            resolve(message)
          }
        })
      })

      if (cancelledRef.current) return

      // Extract salt and derive key
      if (typeof metadata.createdAt !== 'number' || !Number.isFinite(metadata.createdAt)) {
        setState({ status: 'error', message: 'Transfer request missing TTL. Ask sender to generate a new PIN.' })
        return
      }
      if (Date.now() - metadata.createdAt > TRANSFER_EXPIRATION_MS) {
        setState({ status: 'error', message: 'Transfer expired. Ask sender to generate a new PIN.' })
        return
      }

      const salt = new Uint8Array(metadata.salt)
      const key = await deriveKeyFromPinKey(pinMaterial.key, salt)

      if (metadata.totalBytes > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(metadata.totalBytes / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`
        })
        return
      }

      if (
        typeof metadata.fileName !== 'string' ||
        typeof metadata.fileSize !== 'number' ||
        typeof metadata.mimeType !== 'string'
      ) {
        setState({ status: 'error', message: 'Invalid transfer metadata (missing file info)' })
        return
      }

      setState({
        status: 'receiving',
        message: 'Receiving file...',
        contentType: 'file',
        fileMetadata: {
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
        },
        useWebRTC: true,
      })

      // Send ready acknowledgment
      peerRef.current!.send({ type: 'ready' })

      // Receive and decrypt file data
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
      setReceivedContent({
        contentType: 'file',
        data: contentData,
        fileName: metadata.fileName!,
        fileSize: metadata.fileSize!,
        mimeType: metadata.mimeType!,
      })
      setState({
        status: 'complete',
        message: 'File received (P2P)!',
        contentType: 'file',
        fileMetadata: {
          fileName: metadata.fileName!,
          fileSize: metadata.fileSize!,
          mimeType: metadata.mimeType!,
        },
      })

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
