import { useState, useCallback, useRef } from 'react'
import {
  generatePinForMethod,
  generateSalt,
  deriveKeyFromPin,
  encryptChunk,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
  ENCRYPTION_CHUNK_SIZE,
} from '@/lib/crypto'
import {
  derivePeerId,
  PeerJSSignaling,
  type PeerJSMetadata,
  type PeerJSMessage,
} from '@/lib/peerjs-signaling'
import type { TransferState } from '@/lib/nostr/types'
import { readFileAsBytes } from '@/lib/file-utils'

export interface UsePeerJSSendReturn {
  state: TransferState
  pin: string | null
  send: (content: File) => Promise<void>
  cancel: () => void
}

export function usePeerJSSend(): UsePeerJSSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' })
  const [pin, setPin] = useState<string | null>(null)

  const peerRef = useRef<PeerJSSignaling | null>(null)
  const cancelledRef = useRef(false)
  const sendingRef = useRef(false)
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectionCancelRef = useRef<{ cancel: () => void } | null>(null)

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
    if (connectionCancelRef.current) {
      connectionCancelRef.current.cancel()
      connectionCancelRef.current = null
    }
    if (peerRef.current) {
      peerRef.current.close()
      peerRef.current = null
    }
    setPin(null)
    setState({ status: 'idle' })
  }, [clearExpirationTimeout])

  const send = useCallback(async (content: File) => {
    // Guard against concurrent invocations
    if (sendingRef.current) return
    sendingRef.current = true
    cancelledRef.current = false

    try {
      // Get content bytes
      const fileName = content.name
      const fileSize = content.size
      const mimeType = content.type || 'application/octet-stream'

      if (content.size > MAX_MESSAGE_SIZE) {
        const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024
        setState({ status: 'error', message: `File exceeds ${limitMB}MB limit` })
        sendingRef.current = false
        return
      }

      setState({ status: 'connecting', message: 'Reading file...' })
      const contentBytes = await readFileAsBytes(content)

      // Generate PIN and derive encryption key
      setState({ status: 'connecting', message: 'Generating secure PIN...' })
      const newPin = generatePinForMethod('peerjs')
      const sessionStartTime = Date.now()
      setPin(newPin)

      // Set expiration timeout
      clearExpirationTimeout()
      expirationTimeoutRef.current = setTimeout(() => {
        if (!cancelledRef.current && sendingRef.current) {
          setPin(null)
          setState({ status: 'error', message: 'Session expired. Please try again.' })
          sendingRef.current = false
          if (peerRef.current) {
            peerRef.current.close()
            peerRef.current = null
          }
        }
      }, TRANSFER_EXPIRATION_MS)

      const [peerId, salt] = await Promise.all([
        derivePeerId(newPin),
        Promise.resolve(generateSalt())
      ])
      const key = await deriveKeyFromPin(newPin, salt)

      if (cancelledRef.current) return

      // Create PeerJS signaling instance
      setState({ status: 'connecting', message: 'Connecting to signaling server...' })

      await new Promise<void>((resolve, reject) => {
        const peer = new PeerJSSignaling(
          peerId,
          () => resolve(),
          (err) => reject(err)
        )
        peerRef.current = peer
      })

      if (cancelledRef.current) return

      setState({
        status: 'waiting_for_receiver',
        message: 'Waiting for receiver...',
        contentType: 'file',
        fileMetadata: { fileName, fileSize, mimeType },
        useWebRTC: true,
      })

      // Wait for receiver to connect
      await new Promise<void>((resolve, reject) => {
        if (!peerRef.current) {
          reject(new Error('Peer not initialized'))
          return
        }

        connectionCancelRef.current = peerRef.current.waitForConnection(
          () => resolve(),
          TRANSFER_EXPIRATION_MS // Use same timeout as session expiration
        )

        // Also listen for errors
        const originalOnError = (peerRef.current as any).onErrorCallback;
        (peerRef.current as any).onErrorCallback = (err: Error) => {
          reject(err)
          if (originalOnError) originalOnError(err)
        }
      })

      if (cancelledRef.current) return

      // Receiver connected - PIN no longer needed for display
      setPin(null)

      // Enforce TTL
      if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
        throw new Error('Session expired. Please start a new transfer.')
      }

      // Prepare metadata
      const metadata: PeerJSMetadata = {
        type: 'metadata',
        totalBytes: contentBytes.length,
        createdAt: sessionStartTime,
        fileName,
        fileSize,
        mimeType,
        salt: Array.from(salt), // Convert Uint8Array to array for JSON transport
      }

      // Send metadata
      setState({
        status: 'connecting',
        message: 'Sending metadata...',
        contentType: 'file',
        fileMetadata: { fileName, fileSize, mimeType },
      })

      peerRef.current!.send(metadata)

      // Wait for ready acknowledgment
      const isReady = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for receiver ready'))
        }, 30000)

        peerRef.current!.onMessage((message: PeerJSMessage) => {
          if (message.type === 'ready') {
            clearTimeout(timeout)
            resolve(true)
          }
        })
      })

      if (!isReady || cancelledRef.current) return

      // Enforce TTL again right before data transfer begins
      if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
        throw new Error('Session expired. Please start a new transfer.')
      }

      // Transfer file data
      setState({
        status: 'transferring',
        message: 'Sending via P2P...',
        progress: { current: 0, total: contentBytes.length },
        contentType: 'file',
        fileMetadata: { fileName, fileSize, mimeType },
      })

      // Send data in encrypted chunks
      let chunkIndex = 0
      for (let i = 0; i < contentBytes.length; i += ENCRYPTION_CHUNK_SIZE) {
        if (cancelledRef.current) throw new Error('Cancelled')

        const end = Math.min(i + ENCRYPTION_CHUNK_SIZE, contentBytes.length)
        const plainChunk = contentBytes.slice(i, end)

        // Encrypt this chunk with chunk index prefix
        const encryptedChunk = await encryptChunk(key, plainChunk, chunkIndex)

        await peerRef.current!.sendWithBackpressure(encryptedChunk.buffer as ArrayBuffer)

        chunkIndex++

        setState(s => ({
          ...s,
          progress: { current: end, total: contentBytes.length },
        }))
      }

      // Send done signal
      peerRef.current!.send({ type: 'done' })

      // Wait for done_ack
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for completion acknowledgment'))
        }, 60000)

        peerRef.current!.onMessage((message: PeerJSMessage) => {
          if (message.type === 'done_ack') {
            clearTimeout(timeout)
            resolve()
          }
        })
      })

      setState({ status: 'complete', message: 'File sent via P2P!', contentType: 'file' })

    } catch (error) {
      if (!cancelledRef.current) {
        setPin(null)
        setState(prevState => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to send',
        }))
      }
    } finally {
      clearExpirationTimeout()
      sendingRef.current = false
      connectionCancelRef.current = null
      if (peerRef.current) {
        peerRef.current.close()
        peerRef.current = null
      }
    }
  }, [clearExpirationTimeout])

  return { state, pin, send, cancel }
}
