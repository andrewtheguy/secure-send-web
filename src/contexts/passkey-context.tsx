/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react'
import { getPasskeyIdentity } from '@/lib/crypto/passkey'
import { useQRScanner } from '@/hooks/useQRScanner'
import { isMobileDevice } from '@/lib/utils'
import { uint8ArrayToBase64 } from '@/lib/passkey-utils'

export type PageState = 'idle' | 'checking' | 'creating' | 'getting_key' | 'pairing_peer'
export type QRScannerMode = 'invite-code' | 'pairing-request'

interface PasskeyContextState {
  // Identity state
  fingerprint: string | null
  publicIdBase64: string | null
  peerPublicKeyBase64: string | null
  inviteCodeIat: number | null
  prfSupported: boolean | null
  hmacKey: CryptoKey | null

  // Derived values
  inviteCode: string | null

  // UI state
  pageState: PageState
  error: string | null
  success: string | null

  // QR Scanner state
  showQRScanner: boolean
  qrScannerMode: QRScannerMode
  qrScanError: string | null
  facingMode: 'environment' | 'user'
  videoRef: RefObject<HTMLVideoElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  availableCameras: MediaDeviceInfo[]

  // Pairing flow state
  peerInput: string
  pairingComment: string
  outputPairingKey: string | null
  pairingError: string | null

  // Actions
  setPageState: (state: PageState) => void
  setError: (error: string | null) => void
  setSuccess: (success: string | null) => void
  authenticate: () => Promise<boolean>
  resetIdentity: () => void
  resetAll: () => void

  // QR Scanner actions
  openQRScanner: (mode: QRScannerMode) => void
  closeQRScanner: () => void
  switchCamera: () => void
  handleQRScan: (data: Uint8Array) => void

  // Pairing flow actions
  setPeerInput: (value: string) => void
  setPairingComment: (value: string) => void
  setOutputPairingKey: (value: string | null) => void
  setPairingError: (error: string | null) => void
}

const PasskeyContext = createContext<PasskeyContextState | null>(null)

export function usePasskey() {
  const context = useContext(PasskeyContext)
  if (!context) {
    throw new Error('usePasskey must be used within a PasskeyProvider')
  }
  return context
}

interface PasskeyProviderProps {
  children: ReactNode
}

export function PasskeyProvider({ children }: PasskeyProviderProps) {
  // Identity state
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [publicIdBase64, setPublicIdBase64] = useState<string | null>(null)
  const [peerPublicKeyBase64, setPeerPublicKeyBase64] = useState<string | null>(null)
  const [inviteCodeIat, setInviteCodeIat] = useState<number | null>(null)
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null)
  const [hmacKey, setHmacKey] = useState<CryptoKey | null>(null)

  // UI state
  const [pageState, setPageState] = useState<PageState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // QR Scanner state
  const [showQRScanner, setShowQRScanner] = useState(false)
  const [qrScannerMode, setQRScannerMode] = useState<QRScannerMode>('invite-code')
  const [qrScanError, setQRScanError] = useState<string | null>(null)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    isMobileDevice() ? 'environment' : 'user'
  )

  // Pairing flow state
  const [peerInput, setPeerInput] = useState('')
  const [pairingComment, setPairingComment] = useState('')
  const [outputPairingKey, setOutputPairingKey] = useState<string | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)

  // Mounted ref for abort handling
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Derived invite code
  const inviteCode = useMemo(() => {
    if (publicIdBase64 && peerPublicKeyBase64 && inviteCodeIat) {
      return JSON.stringify({ id: publicIdBase64, ppk: peerPublicKeyBase64, iat: inviteCodeIat })
    }
    return null
  }, [publicIdBase64, peerPublicKeyBase64, inviteCodeIat])

  // Auto-clear success message
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  // QR scan handler
  const handleQRScan = useCallback(
    (data: Uint8Array) => {
      try {
        const text = new TextDecoder().decode(data)
        const parsed = JSON.parse(text)

        if (qrScannerMode === 'invite-code') {
          const hasValidIat = typeof parsed.iat === 'number'
          if (typeof parsed.id !== 'string' || typeof parsed.ppk !== 'string' || !hasValidIat) {
            setQRScanError('Invalid invite code format: missing "id", "ppk", or "iat"')
            return
          }
        } else {
          if (typeof parsed.a_id !== 'string' || typeof parsed.init_sig !== 'string') {
            setQRScanError('Invalid pairing request format')
            return
          }
        }

        setPeerInput(text)
        setShowQRScanner(false)
        setQRScanError(null)
      } catch {
        setQRScanError('Invalid QR code: not valid JSON')
      }
    },
    [qrScannerMode]
  )

  const handleQRError = useCallback((err: string) => {
    setQRScanError(err)
  }, [])

  const handleCameraReady = useCallback(() => {
    setQRScanError(null)
  }, [])

  // QR Scanner hook
  const { videoRef, canvasRef, availableCameras } = useQRScanner({
    onScan: handleQRScan,
    onError: handleQRError,
    onCameraReady: handleCameraReady,
    isScanning: showQRScanner,
    facingMode,
  })

  // Actions
  const authenticate = useCallback(async (): Promise<boolean> => {
    setError(null)
    setPageState('getting_key')

    try {
      const result = await getPasskeyIdentity()

      // Check if component is still mounted before updating state
      if (!mountedRef.current) {
        return false
      }

      setFingerprint(result.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(result.publicIdBytes))
      setPeerPublicKeyBase64(uint8ArrayToBase64(result.peerPublicKey))
      setPrfSupported(result.prfSupported)
      setHmacKey(result.hmacKey)
      setInviteCodeIat(Math.floor(Date.now() / 1000))
      setPageState('idle')
      return true
    } catch (err) {
      // Check if component is still mounted before updating state
      if (!mountedRef.current) {
        return false
      }

      setError(err instanceof Error ? err.message : 'Failed to authenticate')
      setPageState('idle')
      return false
    }
  }, [])

  const resetIdentity = useCallback(() => {
    setFingerprint(null)
    setPublicIdBase64(null)
    setPeerPublicKeyBase64(null)
    setInviteCodeIat(null)
    setPrfSupported(null)
    setHmacKey(null)
  }, [])

  const resetAll = useCallback(() => {
    resetIdentity()
    setPeerInput('')
    setPairingComment('')
    setOutputPairingKey(null)
    setPairingError(null)
    setError(null)
    setSuccess(null)
    setPageState('idle')
  }, [resetIdentity])

  const openQRScanner = useCallback((mode: QRScannerMode) => {
    setQRScannerMode(mode)
    setQRScanError(null)
    setShowQRScanner(true)
  }, [])

  const closeQRScanner = useCallback(() => {
    setShowQRScanner(false)
    setQRScanError(null)
  }, [])

  const switchCamera = useCallback(() => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
  }, [])

  const value: PasskeyContextState = {
    // Identity
    fingerprint,
    publicIdBase64,
    peerPublicKeyBase64,
    inviteCodeIat,
    prfSupported,
    hmacKey,
    inviteCode,

    // UI
    pageState,
    error,
    success,

    // QR Scanner
    showQRScanner,
    qrScannerMode,
    qrScanError,
    facingMode,
    videoRef,
    canvasRef,
    availableCameras,

    // Pairing flow
    peerInput,
    pairingComment,
    outputPairingKey,
    pairingError,

    // Actions
    setPageState,
    setError,
    setSuccess,
    authenticate,
    resetIdentity,
    resetAll,
    openQRScanner,
    closeQRScanner,
    switchCamera,
    handleQRScan,
    setPeerInput,
    setPairingComment,
    setOutputPairingKey,
    setPairingError,
  }

  return <PasskeyContext.Provider value={value}>{children}</PasskeyContext.Provider>
}
