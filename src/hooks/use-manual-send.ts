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
import { WebRTCConnection } from '@/lib/webrtc'
import {
  decryptSignalingPayload,
  generateOfferQRBinary,
  generateClipboardData,
  type SignalingPayload,
} from '@/lib/manual-signaling'
import type { TransferState, ContentType } from '@/lib/nostr/types'
import { readFileAsBytes } from '@/lib/file-utils'

// Extended transfer status for Manual Exchange mode
export type ManualTransferStatus =
  | 'idle'
  | 'generating_offer'
  | 'showing_offer_qr'
  | 'waiting_for_answer'
  | 'connecting'
  | 'transferring'
  | 'complete'
  | 'error'

export interface ManualTransferState extends Omit<TransferState, 'status'> {
  status: ManualTransferStatus
  offerQRData?: Uint8Array  // Binary data for QR code (gzipped JSON)
  clipboardData?: string  // Raw JSON for copy button
}

export interface UseManualSendReturn {
  state: ManualTransferState
  pin: string | null
  send: (content: string | File) => Promise<void>
  submitAnswer: (answerData: Uint8Array) => void
  cancel: () => void
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

export function useManualSend(): UseManualSendReturn {
  const [state, setState] = useState<ManualTransferState>({ status: 'idle' })
  const [pin, setPin] = useState<string | null>(null)

  const rtcRef = useRef<WebRTCConnection | null>(null)
  const cancelledRef = useRef(false)
  const sendingRef = useRef(false)
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Store data needed for answer processing
  const pendingTransferRef = useRef<{
    contentBytes: Uint8Array
    contentType: ContentType
    fileName?: string
    fileSize?: number
    mimeType?: string
  } | null>(null)

  // Resolve function for answer submission
  const answerResolverRef = useRef<((payload: SignalingPayload) => void) | null>(null)
  const answerRejectRef = useRef<((error: Error) => void) | null>(null)

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
    answerRejectRef.current = null
    pendingTransferRef.current = null
    if (rtcRef.current) {
      rtcRef.current.close()
      rtcRef.current = null
    }
    setPin(null)
    setState({ status: 'idle' })
  }, [clearExpirationTimeout])

  const submitAnswer = useCallback((answerBinary: Uint8Array) => {
    if (!answerResolverRef.current || !pin) return
    decryptSignalingPayload(answerBinary, pin).then((decrypted) => {
      if (!decrypted) {
        answerRejectRef.current?.(new Error('Invalid PIN or QR response'))
        answerResolverRef.current = null
        return
      }
      if (decrypted.type !== 'answer') {
        answerRejectRef.current?.(new Error('Invalid QR response type'))
        answerResolverRef.current = null
        return
      }
      answerResolverRef.current?.(decrypted)
    })
  }, [pin])

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
      const newPin = generatePinForMethod('manual')
      setPin(newPin)

      const salt = generateSalt()
      const key = await deriveKeyFromPin(newPin, salt)

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

      if (cancelledRef.current) return

      // Store for later use when answer is received
      pendingTransferRef.current = {
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

      // Generate binary QR data with offer + candidates + metadata + salt
      const qrBinaryData = await generateOfferQRBinary(
        offerSDP!,
        iceCandidates,
        {
          contentType,
          totalBytes: contentBytes.length,
          fileName,
          fileSize,
          mimeType,
          salt: Array.from(salt), // Include salt for receiver to derive key
        },
        newPin
      )

      // Generate base64 clipboard data
      const offerPayload: SignalingPayload = {
        type: 'offer',
        sdp: offerSDP!.sdp || '',
        candidates: iceCandidates.map(c => c.candidate),
        contentType,
        totalBytes: contentBytes.length,
        fileName,
        fileSize,
        mimeType,
        salt: Array.from(salt), // Include salt for receiver to derive key
      }
      const clipboardBase64 = await generateClipboardData(offerPayload, newPin)

      // Show QR code and wait for answer
      setState({
        status: 'showing_offer_qr',
        message: 'Show this QR to receiver, then paste their response below',
        offerQRData: qrBinaryData,
        clipboardData: clipboardBase64,
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
      })

      // Wait for answer to be submitted
      const answerPayload = await new Promise<SignalingPayload>((resolve, reject) => {
        answerResolverRef.current = resolve
        answerRejectRef.current = reject

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

      // Send data via P2P (WebRTC DTLS provides transport encryption)
      setState({
        status: 'transferring',
        message: 'Sending via P2P...',
        progress: { current: 0, total: contentBytes.length },
        contentType,
        fileMetadata: isFile ? { fileName: fileName!, fileSize: fileSize!, mimeType: mimeType! } : undefined,
      })

      // Send data in encrypted chunks
      let chunkIndex = 0
      for (let i = 0; i < contentBytes.length; i += ENCRYPTION_CHUNK_SIZE) {
        if (cancelledRef.current) throw new Error('Cancelled')

        const end = Math.min(i + ENCRYPTION_CHUNK_SIZE, contentBytes.length)
        const plainChunk = contentBytes.slice(i, end)

        // Encrypt this chunk with chunk index prefix
        const encryptedChunk = await encryptChunk(key, plainChunk, chunkIndex)

        await rtc.sendWithBackpressure(encryptedChunk)

        chunkIndex++

        setState(s => ({
          ...s,
          progress: { current: end, total: contentBytes.length },
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
      answerRejectRef.current = null
      pendingTransferRef.current = null
      if (rtcRef.current) {
        rtcRef.current.close()
        rtcRef.current = null
      }
    }
  }, [clearExpirationTimeout])

  return { state, pin, send, submitAnswer, cancel }
}
