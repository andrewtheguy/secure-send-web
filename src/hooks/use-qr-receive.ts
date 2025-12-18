import { useState, useCallback, useRef } from 'react'
import {
  isValidPin,
  deriveKeyFromPin,
  decrypt,
  MAX_MESSAGE_SIZE,
} from '@/lib/crypto'
import { WebRTCConnection } from '@/lib/webrtc'
import {
  generateAnswerQRBinary,
  generateClipboardData,
  type SignalingPayload,
} from '@/lib/qr-signaling'
import type { TransferState, ReceivedContent, ContentType } from '@/lib/nostr/types'

// Extended transfer status for QR receive mode
export type QRReceiveStatus =
  | 'idle'
  | 'waiting_for_offer'
  | 'generating_answer'
  | 'showing_answer_qr'
  | 'connecting'
  | 'receiving'
  | 'complete'
  | 'error'

export interface QRReceiveState extends Omit<TransferState, 'status'> {
  status: QRReceiveStatus
  answerQRData?: Uint8Array  // Binary data for QR code (gzipped JSON)
  clipboardData?: string   // Raw JSON for copy button
}

export interface UseQRReceiveReturn {
  state: QRReceiveState
  receivedContent: ReceivedContent | null
  receive: (pin: string) => Promise<void>
  submitOffer: (offerData: SignalingPayload) => void
  cancel: () => void
  reset: () => void
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

export function useQRReceive(): UseQRReceiveReturn {
  const [state, setState] = useState<QRReceiveState>({ status: 'idle' })
  const [receivedContent, setReceivedContent] = useState<ReceivedContent | null>(null)

  const rtcRef = useRef<WebRTCConnection | null>(null)
  const cancelledRef = useRef(false)
  const receivingRef = useRef(false)

  // Store PIN for key derivation after offer is received
  const pinRef = useRef<string | null>(null)

  // Resolve function for offer submission
  const offerResolverRef = useRef<((payload: SignalingPayload) => void) | null>(null)

  const cancel = useCallback(() => {
    cancelledRef.current = true
    receivingRef.current = false
    offerResolverRef.current = null
    pinRef.current = null
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

  const submitOffer = useCallback((offerPayload: SignalingPayload) => {
    if (offerResolverRef.current) {
      offerResolverRef.current(offerPayload)
    }
  }, [])

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

      pinRef.current = pin

      // Show input for pasting offer QR data
      setState({
        status: 'waiting_for_offer',
        message: 'Scan sender\'s QR code and paste the data below',
      })

      // Wait for offer to be submitted
      const offerPayload = await new Promise<SignalingPayload>((resolve, reject) => {
        offerResolverRef.current = resolve

        // Check periodically if cancelled
        const checkInterval = setInterval(() => {
          if (cancelledRef.current) {
            clearInterval(checkInterval)
            reject(new Error('Cancelled'))
          }
        }, 500)
      })

      if (cancelledRef.current) return

      // Validate offer payload
      if (offerPayload.type !== 'offer') {
        setState({ status: 'error', message: 'Invalid QR: Expected offer data' })
        return
      }

      // Extract metadata from offer
      const { contentType, totalBytes, fileName, fileSize, mimeType, salt } = offerPayload
      const isFile = contentType === 'file'

      // Security check: Enforce MAX_MESSAGE_SIZE
      if (totalBytes && totalBytes > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(totalBytes / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`
        })
        return
      }

      // Derive key from PIN and salt
      setState({ status: 'generating_answer', message: 'Processing offer...' })
      const saltBytes = new Uint8Array(salt || [])
      const key = await deriveKeyFromPin(pin, saltBytes)

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

      const rtc = new WebRTCConnection(
        ICE_CONFIG,
        (signal) => {
          // Collect signals (answer + candidates)
          if (signal.type === 'answer') {
            answerSDP = signal
          } else if (signal.type === 'candidate' && signal.candidate) {
            iceCandidates.push(signal.candidate)
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
            const chunk = new Uint8Array(data)
            receivedChunks.push(chunk)
            receivedBytes += chunk.length

            setState(s => ({
              ...s,
              progress: {
                current: receivedBytes,
                total: totalBytes || 0,
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

      // Wait for ICE gathering to complete
      setState({ status: 'generating_answer', message: 'Gathering network info...' })

      await new Promise<void>((resolve) => {
        const checkIce = () => {
          const pc = (rtc as any).pc as RTCPeerConnection
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

      // Generate binary QR data with answer + candidates
      const qrBinaryData = generateAnswerQRBinary(answerSDP!, iceCandidates)

      // Generate raw JSON for clipboard
      const answerPayload: SignalingPayload = {
        type: 'answer',
        sdp: answerSDP!.sdp || '',
        candidates: iceCandidates.map(c => c.candidate),
      }
      const clipboardJson = generateClipboardData(answerPayload)

      // Show QR code and wait for connection
      setState({
        status: 'showing_answer_qr',
        message: 'Show this QR to sender and wait for connection',
        answerQRData: qrBinaryData,
        clipboardData: clipboardJson,
        contentType: contentType as ContentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
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
        const dc = (rtc as any).dataChannel as RTCDataChannel
        if (dc && dc.readyState === 'open') {
          clearTimeout(timeout)
          resolve()
        }
      })

      if (cancelledRef.current) return

      setState({
        status: 'receiving',
        message: `Receiving ${isFile ? 'file' : 'message'}...`,
        contentType: contentType as ContentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
        useWebRTC: true,
        progress: { current: 0, total: totalBytes || 0 },
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

      // Combine chunks
      const totalLength = receivedChunks.reduce((acc, chunk) => acc + chunk.length, 0)
      const encryptedData = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of receivedChunks) {
        encryptedData.set(chunk, offset)
        offset += chunk.length
      }

      // Decrypt
      setState(s => ({ ...s, message: 'Decrypting...' }))
      const decryptedData = await decrypt(key, encryptedData)

      // Set received content
      if (contentType === 'file') {
        setReceivedContent({
          contentType: 'file',
          data: decryptedData,
          fileName: fileName!,
          fileSize: fileSize!,
          mimeType: mimeType!,
        })
        setState({
          status: 'complete',
          message: 'File received (P2P via QR)!',
          contentType: 'file',
          fileMetadata: {
            fileName: fileName!,
            fileSize: fileSize!,
            mimeType: mimeType!,
          },
        })
      } else {
        const message = new TextDecoder().decode(decryptedData)
        setReceivedContent({
          contentType: 'text',
          message,
        })
        setState({
          status: 'complete',
          message: 'Message received (P2P via QR)!',
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
      offerResolverRef.current = null
      pinRef.current = null
      if (rtcRef.current) {
        rtcRef.current.close()
        rtcRef.current = null
      }
    }
  }, [])

  return { state, receivedContent, receive, submitOffer, cancel, reset }
}
