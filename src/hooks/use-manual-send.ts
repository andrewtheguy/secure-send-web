import { useState, useCallback, useRef } from 'react'
import {
  generateSalt,
  generateECDHKeyPair,
  deriveSharedSecretKey,
  deriveAESKeyFromSecretKey,
  encryptChunk,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
  ENCRYPTION_CHUNK_SIZE,
} from '@/lib/crypto'
import { WebRTCConnection } from '@/lib/webrtc'
import { getWebRTCConfig } from '@/lib/webrtc-config'
import {
  generateMutualOfferBinary,
  generateMutualClipboardData,
  parseMutualPayload,
  type SignalingPayload,
} from '@/lib/manual-signaling'
import type { TransferState } from '@/lib/nostr/types'
import { readFileAsBytes } from '@/lib/file-utils'

// Extended transfer status for Manual Exchange mode
export type ManualTransferStatus =
  | 'idle'
  | 'generating_offer'
  | 'showing_offer'
  | 'waiting_for_answer'
  | 'connecting'
  | 'transferring'
  | 'complete'
  | 'error'

export interface ManualTransferState extends Omit<TransferState, 'status'> {
  status: ManualTransferStatus
  offerData?: Uint8Array // Binary data for QR code
  clipboardData?: string // Base64 for copy button
}

export interface UseManualSendReturn {
  state: ManualTransferState
  send: (content: File) => Promise<void>
  submitAnswer: (answerData: Uint8Array) => void
  cancel: () => void
}


export function useManualSend(): UseManualSendReturn {
  const [state, setState] = useState<ManualTransferState>({ status: 'idle' })

  const rtcRef = useRef<WebRTCConnection | null>(null)
  const cancelledRef = useRef(false)
  const sendingRef = useRef(false)
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Store ECDH private key for computing shared secret when answer arrives
  const ecdhPrivateKeyRef = useRef<CryptoKey | null>(null)
  const saltRef = useRef<Uint8Array | null>(null)

  // Store data needed for answer processing
  const pendingTransferRef = useRef<{
    contentBytes: Uint8Array
    fileName: string
    fileSize: number
    mimeType: string
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
    ecdhPrivateKeyRef.current = null
    saltRef.current = null
    if (rtcRef.current) {
      rtcRef.current.close()
      rtcRef.current = null
    }
    setState({ status: 'idle' })
  }, [clearExpirationTimeout])

  const submitAnswer = useCallback((answerBinary: Uint8Array) => {
    if (!answerResolverRef.current) return

    // Parse mutual payload (no decryption needed)
    const parsed = parseMutualPayload(answerBinary)
    if (!parsed) {
      answerRejectRef.current?.(new Error('Invalid response format'))
      answerResolverRef.current = null
      return
    }
    if (parsed.type !== 'answer') {
      answerRejectRef.current?.(new Error('Expected answer, got offer'))
      answerResolverRef.current = null
      return
    }
    if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) {
      answerRejectRef.current?.(new Error('Invalid response: missing timestamp'))
      answerResolverRef.current = null
      return
    }
    answerResolverRef.current?.(parsed)
  }, [])

  const send = useCallback(async (content: File) => {
    // Guard against concurrent invocations
    if (sendingRef.current) return
    sendingRef.current = true
    cancelledRef.current = false


    try {
      // Validate and sanitize metadata
      const rawFileName = content.name || ''
      const sanitizedFileName = rawFileName.trim()

      if (!sanitizedFileName) {
        setState({ status: 'error', message: 'Missing file name' })
        sendingRef.current = false
        return
      }

      const fileName = sanitizedFileName
      const fileSize = content.size
      const mimeType = content.type || 'application/octet-stream'

      if (typeof fileSize !== 'number' || !Number.isFinite(fileSize)) {
        setState({ status: 'error', message: 'Invalid file size' })
        sendingRef.current = false
        return
      }

      if (fileSize <= 0) {
        setState({ status: 'error', message: 'File is empty' })
        sendingRef.current = false
        return
      }

      if (fileSize > MAX_MESSAGE_SIZE) {
        const limitMB = MAX_MESSAGE_SIZE / 1024 / 1024
        setState({ status: 'error', message: `File exceeds ${limitMB}MB limit` })
        sendingRef.current = false
        return
      }

      setState({ status: 'generating_offer', message: 'Reading file...' })
      const contentBytes = await readFileAsBytes(content)

      // Generate ECDH keypair and salt
      setState({ status: 'generating_offer', message: 'Generating keys...' })
      const sessionStartTime = Date.now()

      const ecdhKeyPair = await generateECDHKeyPair()
      ecdhPrivateKeyRef.current = ecdhKeyPair.privateKey
      const salt = generateSalt()
      saltRef.current = salt

      // Set expiration timeout
      clearExpirationTimeout()
      expirationTimeoutRef.current = setTimeout(() => {
        if (!cancelledRef.current && sendingRef.current) {
          setState({ status: 'error', message: 'Session expired. Please try again.' })
          sendingRef.current = false
          answerResolverRef.current = null
          pendingTransferRef.current = null
          ecdhPrivateKeyRef.current = null
          saltRef.current = null
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
        fileName,
        fileSize,
        mimeType,
      }

      // Create WebRTC connection and offer
      setState({ status: 'generating_offer', message: 'Creating P2P offer...' })

      const iceCandidates: RTCIceCandidate[] = []
      let offerSDP: RTCSessionDescriptionInit | null = null

      const rtc = new WebRTCConnection(
        getWebRTCConfig(),
        (signal) => {
          // Collect signals (offer + candidates)
          if (signal.type === 'offer') {
            offerSDP = { type: 'offer', sdp: signal.sdp }
          } else if (signal.type === 'candidate' && signal.candidate) {
            iceCandidates.push(new RTCIceCandidate(signal.candidate))
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

      // Generate binary offer data with ECDH public key
      const offerBinary = generateMutualOfferBinary(
        offerSDP!,
        iceCandidates,
        {
          createdAt: sessionStartTime,
          totalBytes: contentBytes.length,
          fileName,
          fileSize,
          mimeType,
          publicKey: ecdhKeyPair.publicKeyBytes,
          salt,
        }
      )

      // Generate base64 clipboard data
      const clipboardBase64 = generateMutualClipboardData(offerBinary)

      // Show offer and wait for answer
      setState({
        status: 'showing_offer',
        message: 'Show this to receiver, then scan/paste their response',
        offerData: offerBinary,
        clipboardData: clipboardBase64,
        contentType: 'file',
        fileMetadata: { fileName, fileSize, mimeType },
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

      // Enforce TTL: refuse to proceed with old answers/offers
      if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
        throw new Error('Session expired. Please start a new transfer.')
      }

      // Derive shared secret from receiver's public key
      setState({ status: 'connecting', message: 'Establishing secure connection...' })

      if (!ecdhPrivateKeyRef.current || !saltRef.current) {
        throw new Error('Cryptographic state missing. Please try again.')
      }

      const receiverPublicKey = new Uint8Array(answerPayload.publicKey!)
      // Derive shared secret as non-extractable CryptoKey
      const sharedSecretKey = await deriveSharedSecretKey(ecdhPrivateKeyRef.current, receiverPublicKey)
      const key = await deriveAESKeyFromSecretKey(sharedSecretKey, saltRef.current)

      // Clear ECDH private key - no longer needed
      ecdhPrivateKeyRef.current = null

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

        const pc = rtc.getPeerConnection()
        const checkConnection = () => {
          if (pc.connectionState === 'connected') {
            const dc = rtc.getDataChannel()
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
        const dc = rtc.getDataChannel()
        if (dc) {
          dc.onopen = () => {
            clearTimeout(timeout)
            resolve()
          }
        }
        checkConnection()
      })

      if (cancelledRef.current) return

      // Enforce TTL again right before data transfer begins
      if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
        throw new Error('Session expired. Please start a new transfer.')
      }

      // Send data via P2P (WebRTC DTLS provides transport encryption)
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

        const dc = rtc.getDataChannel()
        if (!dc) {
          clearTimeout(timeout)
          reject(new Error('Data channel unavailable'))
          return
        }
        dc.onmessage = (event) => {
          if (event.data === 'ACK') {
            clearTimeout(timeout)
            resolve()
          }
        }
      })

      setState({ status: 'complete', message: 'File sent via P2P!', contentType: 'file' })

    } catch (error) {
      if (!cancelledRef.current) {
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
      ecdhPrivateKeyRef.current = null
      saltRef.current = null
      if (rtcRef.current) {
        rtcRef.current.close()
        rtcRef.current = null
      }
    }
  }, [clearExpirationTimeout])

  return { state, send, submitAnswer, cancel }
}
