import { useState, useCallback, useRef } from 'react'
import {
  generatePinForMethod,
  generateSalt,
  deriveKeyFromPin,
  encrypt,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto'
import { WebRTCConnection } from '@/lib/webrtc'
import {
  generateOfferQRData,
  generateClipboardData,
  type SignalingPayload,
} from '@/lib/qr-signaling'
import type { TransferState, ContentType } from '@/lib/nostr/types'
import { readFileAsBytes } from '@/lib/file-utils'

// Extended transfer status for QR mode
export type QRTransferStatus =
  | 'idle'
  | 'generating_offer'
  | 'showing_offer_qr'
  | 'waiting_for_answer'
  | 'connecting'
  | 'transferring'
  | 'complete'
  | 'error'

export interface QRTransferState extends Omit<TransferState, 'status'> {
  status: QRTransferStatus
  offerQRData?: string[]  // Array of QR chunks to display
  clipboardData?: string  // Raw JSON for copy button
}

export interface UseQRSendReturn {
  state: QRTransferState
  pin: string | null
  send: (content: string | File) => Promise<void>
  submitAnswer: (answerData: SignalingPayload) => void
  cancel: () => void
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

export function useQRSend(): UseQRSendReturn {
  const [state, setState] = useState<QRTransferState>({ status: 'idle' })
  const [pin, setPin] = useState<string | null>(null)

  const rtcRef = useRef<WebRTCConnection | null>(null)
  const cancelledRef = useRef(false)
  const sendingRef = useRef(false)
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Store data needed for answer processing
  const pendingTransferRef = useRef<{
    key: CryptoKey
    contentBytes: Uint8Array
    contentType: ContentType
    fileName?: string
    fileSize?: number
    mimeType?: string
  } | null>(null)

  // Resolve function for answer submission
  const answerResolverRef = useRef<((payload: SignalingPayload) => void) | null>(null)

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
    answerResolverRef.current = null
    pendingTransferRef.current = null
    if (rtcRef.current) {
      rtcRef.current.close()
      rtcRef.current = null
    }
    setPin(null)
    setState({ status: 'idle' })
  }, [clearExpirationTimeout])

  const submitAnswer = useCallback((answerPayload: SignalingPayload) => {
    if (answerResolverRef.current) {
      answerResolverRef.current(answerPayload)
    }
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
          const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024
          setState({ status: 'error', message: `File exceeds ${limitMB}MB limit` })
          return
        }

        setState({ status: 'generating_offer', message: 'Reading file...' })
        contentBytes = await readFileAsBytes(content)
      } else {
        const encoder = new TextEncoder()
        contentBytes = encoder.encode(content)

        if (contentBytes.length > MAX_MESSAGE_SIZE) {
          const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024
          setState({ status: 'error', message: `Message exceeds ${limitMB}MB limit` })
          return
        }
      }

      // Generate PIN and derive encryption key
      setState({ status: 'generating_offer', message: 'Generating secure PIN...' })
      const newPin = generatePinForMethod('qr')
      setPin(newPin)

      // Set expiration timeout
      clearExpirationTimeout()
      expirationTimeoutRef.current = setTimeout(() => {
        if (!cancelledRef.current && sendingRef.current) {
          setPin(null)
          setState({ status: 'error', message: 'Session expired. Please try again.' })
          sendingRef.current = false
          answerResolverRef.current = null
          pendingTransferRef.current = null
          if (rtcRef.current) {
            rtcRef.current.close()
            rtcRef.current = null
          }
        }
      }, TRANSFER_EXPIRATION_MS)

      const salt = generateSalt()
      const key = await deriveKeyFromPin(newPin, salt)

      if (cancelledRef.current) return

      // Store for later use when answer is received
      pendingTransferRef.current = {
        key,
        contentBytes,
        contentType,
        fileName,
        fileSize,
        mimeType,
      }

      // Create WebRTC connection and offer
      setState({ status: 'generating_offer', message: 'Creating P2P offer...' })

      const iceCandidates: RTCIceCandidate[] = []
      let offerSDP: RTCSessionDescriptionInit | null = null

      const rtc = new WebRTCConnection(
        ICE_CONFIG,
        (signal) => {
          // Collect signals (offer + candidates)
          if (signal.type === 'offer') {
            offerSDP = signal
          } else if (signal.type === 'candidate' && signal.candidate) {
            iceCandidates.push(signal.candidate)
          }
        },
        () => {
          // Data channel opened - will be handled later
        },
        () => {
          // Message received - will be handled later
        }
      )

      rtcRef.current = rtc
      rtc.createDataChannel('file-transfer')

      // Create offer
      await rtc.createOffer()

      if (cancelledRef.current) return

      // Wait for ICE gathering to complete
      setState({ status: 'generating_offer', message: 'Gathering network info...' })

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

      // Generate QR data with offer + candidates + metadata
      const qrChunks = generateOfferQRData(
        offerSDP!,
        iceCandidates,
        salt,
        {
          contentType,
          totalBytes: contentBytes.length,
          fileName,
          fileSize,
          mimeType,
        }
      )

      // Generate raw JSON for clipboard
      const payload: SignalingPayload = {
        type: 'offer',
        sdp: offerSDP!.sdp || '',
        candidates: iceCandidates.map(c => c.candidate),
        salt: Array.from(salt),
        contentType,
        totalBytes: contentBytes.length,
        fileName,
        fileSize,
        mimeType,
      }
      const clipboardJson = generateClipboardData(payload)

      // Show QR code and wait for answer
      setState({
        status: 'showing_offer_qr',
        message: 'Show this QR to receiver, then paste their response below',
        offerQRData: qrChunks,
        clipboardData: clipboardJson,
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
      })

      // Wait for answer to be submitted
      const answerPayload = await new Promise<SignalingPayload>((resolve, reject) => {
        answerResolverRef.current = resolve

        // Check periodically if cancelled
        const checkInterval = setInterval(() => {
          if (cancelledRef.current) {
            clearInterval(checkInterval)
            reject(new Error('Cancelled'))
          }
        }, 500)
      })

      if (cancelledRef.current) return

      // Process answer
      setState({ status: 'connecting', message: 'Establishing connection...' })

      // Handle answer signal
      await rtc.handleSignal({ type: 'answer', sdp: answerPayload.sdp })

      // Add ICE candidates from answer
      for (const candidateStr of answerPayload.candidates) {
        await rtc.handleSignal({
          type: 'candidate',
          candidate: { candidate: candidateStr, sdpMid: '0', sdpMLineIndex: 0 },
        })
      }

      // Wait for data channel to open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'))
        }, 30000)

        const pc = (rtc as any).pc as RTCPeerConnection
        const checkConnection = () => {
          if (pc.connectionState === 'connected') {
            const dc = (rtc as any).dataChannel as RTCDataChannel
            if (dc && dc.readyState === 'open') {
              clearTimeout(timeout)
              resolve()
            }
          } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            clearTimeout(timeout)
            reject(new Error('Connection failed'))
          }
        }

        pc.onconnectionstatechange = checkConnection
        const dc = (rtc as any).dataChannel as RTCDataChannel
        if (dc) {
          dc.onopen = () => {
            clearTimeout(timeout)
            resolve()
          }
        }
        checkConnection()
      })

      if (cancelledRef.current) return

      // Hide PIN now that we're connected
      setPin(null)

      // Encrypt content
      setState({
        status: 'transferring',
        message: 'Encrypting...',
        progress: { current: 0, total: contentBytes.length },
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
      })

      const encryptedData = await encrypt(key, contentBytes)

      if (cancelledRef.current) return

      // Send encrypted data
      setState({
        status: 'transferring',
        message: 'Sending via P2P...',
        progress: { current: 0, total: encryptedData.length },
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
      })

      // Send data in chunks
      const chunkSize = 16384 // 16KB chunks
      for (let i = 0; i < encryptedData.length; i += chunkSize) {
        if (cancelledRef.current) throw new Error('Cancelled')

        const end = Math.min(i + chunkSize, encryptedData.length)
        const chunk = encryptedData.slice(i, end)

        await rtc.sendWithBackpressure(chunk.buffer)

        setState(s => ({
          ...s,
          progress: { current: end, total: encryptedData.length },
        }))
      }

      // Send done signal
      rtc.send('DONE')

      // Wait for acknowledgment
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for acknowledgment'))
        }, 30000)

        const dc = (rtc as any).dataChannel as RTCDataChannel
        dc.onmessage = (event) => {
          if (event.data === 'ACK') {
            clearTimeout(timeout)
            resolve()
          }
        }
      })

      const successMsg = isFile ? 'File sent via P2P!' : 'Message sent via P2P!'
      setState({ status: 'complete', message: successMsg, contentType })

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
      answerResolverRef.current = null
      pendingTransferRef.current = null
      if (rtcRef.current) {
        rtcRef.current.close()
        rtcRef.current = null
      }
    }
  }, [clearExpirationTimeout])

  return { state, pin, send, submitAnswer, cancel }
}
