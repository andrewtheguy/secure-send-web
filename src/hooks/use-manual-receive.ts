import { useState, useCallback, useRef } from 'react'
import {
  generateECDHKeyPair,
  deriveSharedSecret,
  deriveAESKeyFromSecret,
  parseChunkMessage,
  decryptChunk,
  MAX_MESSAGE_SIZE,
  ENCRYPTION_CHUNK_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto'
import { WebRTCConnection } from '@/lib/webrtc'
import {
  parseMutualPayload,
  generateMutualAnswerBinary,
  generateMutualClipboardData,
  type SignalingPayload,
} from '@/lib/manual-signaling'
import type { TransferState } from '@/lib/nostr/types'
import type { ReceivedContent } from '@/lib/types'

// Extended transfer status for Manual Exchange receive mode
export type ManualReceiveStatus =
  | 'idle'
  | 'waiting_for_offer'
  | 'generating_answer'
  | 'showing_answer'
  | 'connecting'
  | 'receiving'
  | 'complete'
  | 'error'

export interface ManualReceiveState extends Omit<TransferState, 'status'> {
  status: ManualReceiveStatus
  answerData?: Uint8Array // Binary data for QR code
  clipboardData?: string // Base64 for copy button
}

export interface UseManualReceiveReturn {
  state: ManualReceiveState
  receivedContent: ReceivedContent | null
  startReceive: () => void
  submitOffer: (offerData: Uint8Array) => void
  cancel: () => void
  reset: () => void
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

export function useManualReceive(): UseManualReceiveReturn {
  const [state, setState] = useState<ManualReceiveState>({ status: 'idle' })
  const [receivedContent, setReceivedContent] = useState<ReceivedContent | null>(null)

  const rtcRef = useRef<WebRTCConnection | null>(null)
  const cancelledRef = useRef(false)
  const receivingRef = useRef(false)

  // Resolve function for offer submission
  const offerResolverRef = useRef<((payload: SignalingPayload) => void) | null>(null)
  const offerRejectRef = useRef<((error: Error) => void) | null>(null)

  const cancel = useCallback(() => {
    cancelledRef.current = true
    receivingRef.current = false
    offerResolverRef.current = null
    offerRejectRef.current = null
    if (rtcRef.current) {
      rtcRef.current.close()
      rtcRef.current = null
    }
    setState({ status: 'idle' })
  }, [])

  const reset = useCallback(() => {
    cancel()
    setReceivedContent(null)
  }, [cancel])

  const submitOffer = useCallback((offerBinary: Uint8Array) => {
    if (!offerResolverRef.current) return

    // Parse mutual payload (no decryption needed)
    const parsed = parseMutualPayload(offerBinary)
    if (!parsed) {
      offerRejectRef.current?.(new Error('Invalid offer format'))
      offerResolverRef.current = null
      return
    }
    if (parsed.type !== 'offer') {
      offerRejectRef.current?.(new Error('Expected offer, got answer'))
      offerResolverRef.current = null
      return
    }
    offerResolverRef.current?.(parsed)
  }, [])

  const startReceive = useCallback(() => {
    // Guard against concurrent invocations
    if (receivingRef.current) return
    receivingRef.current = true
    cancelledRef.current = false
    setReceivedContent(null)

    // Start the receive flow
    doReceive()
  }, [])

  const doReceive = async () => {
    try {
      // Show input for scanning/pasting offer
      setState({
        status: 'waiting_for_offer',
        message: 'Scan or paste the sender\'s code',
      })

      // Wait for offer to be submitted
      const offerPayload = await new Promise<SignalingPayload>((resolve, reject) => {
        offerResolverRef.current = resolve
        offerRejectRef.current = reject

        // Check periodically if cancelled
        const checkInterval = setInterval(() => {
          if (cancelledRef.current) {
            clearInterval(checkInterval)
            reject(new Error('Cancelled'))
          }
        }, 500)
      })

      if (cancelledRef.current) return

      // Enforce TTL
      if (typeof offerPayload.createdAt !== 'number' || !Number.isFinite(offerPayload.createdAt)) {
        setState({ status: 'error', message: 'Offer missing timestamp. Ask sender to create a new one.' })
        return
      }
      if (Date.now() - offerPayload.createdAt > TRANSFER_EXPIRATION_MS) {
        setState({ status: 'error', message: 'Offer expired. Ask sender to create a new one.' })
        return
      }

      // Extract metadata from offer
      const { totalBytes, fileName, fileSize, mimeType, salt: saltArray, publicKey: senderPublicKeyArray } = offerPayload

      // Validate required fields
      if (!saltArray) {
        setState({ status: 'error', message: 'Invalid offer: missing encryption salt' })
        return
      }

      // Validate required metadata
      if (
        !fileName ||
        !mimeType ||
        typeof fileSize !== 'number' ||
        !Number.isFinite(fileSize) ||
        fileSize < 0 ||
        typeof totalBytes !== 'number' ||
        !Number.isFinite(totalBytes) ||
        totalBytes < 0
      ) {
        setState({ status: 'error', message: 'Invalid offer: missing or invalid file metadata' })
        return
      }

      // Security check: Enforce MAX_MESSAGE_SIZE
      if (totalBytes > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(totalBytes / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`
        })
        return
      }

      if (cancelledRef.current) return

      // Generate our ECDH keypair and derive shared secret
      setState({ status: 'generating_answer', message: 'Generating keys...' })

      const ecdhKeyPair = await generateECDHKeyPair()
      const senderPublicKey = new Uint8Array(senderPublicKeyArray)
      const salt = new Uint8Array(saltArray)

      const sharedSecret = await deriveSharedSecret(ecdhKeyPair.privateKey, senderPublicKey)
      const key = await deriveAESKeyFromSecret(sharedSecret, salt)

      if (cancelledRef.current) return

      // Create WebRTC connection and handle offer
      setState({ status: 'generating_answer', message: 'Creating P2P answer...' })

      const iceCandidates: RTCIceCandidate[] = []
      let answerSDP: RTCSessionDescriptionInit | null = null

      // Track received data
      const receivedChunks: Uint8Array[] = []
      let receivedBytes = 0
      let transferComplete = false
      let dataChannelResolver: (() => void) | null = null
      let transferResolver: (() => void) | null = null
      let answerSDPResolver: (() => void) | null = null

      const rtc = new WebRTCConnection(
        ICE_CONFIG,
        (signal) => {
          // Collect signals (answer + candidates)
          if (signal.type === 'answer') {
            answerSDP = { type: 'answer', sdp: signal.sdp }
            if (answerSDPResolver) {
              answerSDPResolver()
            }
          } else if (signal.type === 'candidate' && signal.candidate) {
            iceCandidates.push(new RTCIceCandidate(signal.candidate))
          }
        },
        () => {
          // Data channel opened
          if (dataChannelResolver) {
            dataChannelResolver()
          }
        },
        (data) => {
          // Message received
          if (typeof data === 'string') {
            if (data === 'DONE') {
              transferComplete = true
              if (transferResolver) {
                transferResolver()
              }
            }
          } else if (data instanceof ArrayBuffer) {
            // Store encrypted chunk for later decryption
            const encryptedChunk = new Uint8Array(data)
            receivedChunks.push(encryptedChunk)
            receivedBytes += encryptedChunk.length

            setState(s => ({
              ...s,
              progress: {
                current: receivedBytes,
                total: totalBytes!,
              },
            }))
          }
        }
      )

      rtcRef.current = rtc

      // Handle offer signal
      await rtc.handleSignal({ type: 'offer', sdp: offerPayload.sdp })

      // Add ICE candidates from offer
      for (const candidateStr of offerPayload.candidates) {
        await rtc.handleSignal({
          type: 'candidate',
          candidate: { candidate: candidateStr, sdpMid: '0', sdpMLineIndex: 0 },
        })
      }

      if (cancelledRef.current) return

      // Wait for answer SDP to be generated
      setState({ status: 'generating_answer', message: 'Generating answer...' })

      await new Promise<void>((resolve) => {
        if (answerSDP) {
          resolve()
        } else {
          answerSDPResolver = resolve
          // Timeout after 10 seconds
          setTimeout(resolve, 10000)
        }
      })

      if (cancelledRef.current) return

      // Wait for ICE gathering to complete
      setState({ status: 'generating_answer', message: 'Gathering network info...' })

      await new Promise<void>((resolve) => {
        const checkIce = () => {
          const pc = rtc.getPeerConnection()
          if (pc.iceGatheringState === 'complete') {
            resolve()
          } else {
            pc.onicegatheringstatechange = () => {
              if (pc.iceGatheringState === 'complete') {
                resolve()
              }
            }
            // Also timeout after 10 seconds
            setTimeout(resolve, 10000)
          }
        }
        checkIce()
      })

      if (cancelledRef.current) return

      // Validate answerSDP is available
      if (!answerSDP) {
        throw new Error('Failed to generate answer SDP: Answer was not created by WebRTC connection')
      }

      // Generate answer with our public key
      const answerBinary = generateMutualAnswerBinary(answerSDP, iceCandidates, ecdhKeyPair.publicKeyBytes)
      const clipboardBase64 = generateMutualClipboardData(answerBinary)

      // Show answer and wait for connection
      setState({
        status: 'showing_answer',
        message: 'Show this to sender and wait for connection',
        answerData: answerBinary,
        clipboardData: clipboardBase64,
        contentType: 'file',
        fileMetadata: { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! },
      })

      // Wait for data channel to open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'))
        }, 60000) // 60 seconds for connection

        dataChannelResolver = () => {
          clearTimeout(timeout)
          resolve()
        }

        // Check if already open
        const dc = rtc.getDataChannel()
        if (dc && dc.readyState === 'open') {
          clearTimeout(timeout)
          resolve()
        }
      })

      if (cancelledRef.current) return

      setState({
        status: 'receiving',
        message: 'Receiving file...',
        contentType: 'file',
        fileMetadata: { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! },
        useWebRTC: true,
        progress: { current: 0, total: totalBytes! },
      })

      // Wait for transfer to complete
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Transfer timeout'))
        }, 10 * 60 * 1000) // 10 minutes

        transferResolver = () => {
          clearTimeout(timeout)
          resolve()
        }

        // Check if already complete
        if (transferComplete) {
          clearTimeout(timeout)
          resolve()
        }

        // Check periodically for cancellation
        const checkInterval = setInterval(() => {
          if (cancelledRef.current) {
            clearInterval(checkInterval)
            clearTimeout(timeout)
            reject(new Error('Cancelled'))
          }
        }, 500)
      })

      if (cancelledRef.current) return

      // Send acknowledgment
      rtc.send('ACK')

      // Decrypt and reassemble chunks
      let contentData = new Uint8Array(totalBytes!)
      let totalDecryptedBytes = 0

      for (const encryptedChunk of receivedChunks) {
        try {
          // Parse chunk to get index and encrypted data
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

          // Write to correct position based on chunk index
          contentData.set(decryptedChunk, writePosition)
          totalDecryptedBytes += decryptedChunk.length
        } catch (err) {
          console.error('Failed to decrypt chunk:', err)
        }
      }

      // Trim buffer to actual content size
      const receivedData = contentData.slice(0, totalDecryptedBytes)

      // Set received content
      setReceivedContent({
        contentType: 'file',
        data: receivedData,
        fileName: fileName!,
        fileSize: fileSize!,
        mimeType: mimeType!,
      })
      setState({
        status: 'complete',
        message: 'File received (P2P)!',
        contentType: 'file',
        fileMetadata: {
          fileName: fileName!,
          fileSize: fileSize!,
          mimeType: mimeType!,
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
      offerResolverRef.current = null
      offerRejectRef.current = null
      if (rtcRef.current) {
        rtcRef.current.close()
        rtcRef.current = null
      }
    }
  }

  return { state, receivedContent, startReceive, submitOffer, cancel, reset }
}
