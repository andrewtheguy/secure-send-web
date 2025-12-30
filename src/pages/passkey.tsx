import { useState, useMemo, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Fingerprint,
  Plus,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Copy,
  Check,
  Key,
  Shield,
  ArrowLeft,
  Camera,
  X,
  RefreshCw,
  Download,
  Info,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Textarea } from '@/components/ui/textarea'
import { QRCodeSVG } from 'qrcode.react'
import {
  checkWebAuthnSupport,
  createPasskeyCredential,
  getPasskeyIdentity,
} from '@/lib/crypto/passkey'
import { formatFingerprint } from '@/lib/crypto/ecdh'
import {
  createPairingRequest,
  confirmPairingRequest,
  isPairingRequestFormat,
  IDENTITY_CARD_TTL_SECONDS,
  MAX_ACCEPTABLE_CLOCK_SKEW_SECONDS,
} from '@/lib/crypto/pairing-key'
import { PIN_WORDLIST } from '@/lib/crypto/constants'
import { ValidationError } from '@/lib/errors'
import { useQRScanner } from '@/hooks/useQRScanner'
import { generateTextQRCode } from '@/lib/qr-utils'
import { isMobileDevice } from '@/lib/utils'
import { downloadTextFile } from '@/lib/file-utils'

type PageState = 'idle' | 'checking' | 'creating' | 'getting_key' | 'pairing_peer'

// Active mode for "Already Have a Passkey?" section
type ActiveMode = 'idle' | 'signer' | 'initiator'

// Identity card format: JSON with id (public ID), ppk (peer public key), and iat (issued-at)
interface IdentityCard {
  id: string // base64 public ID (32 bytes)
  ppk: string // base64 peer public key (32 bytes, HKDF-derived)
  iat: number // issued-at timestamp (Unix seconds) - valid for 24 hours
}

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''))
}

// Helper to convert base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Parse an identity card from JSON format
function parseIdentityInput(input: string): IdentityCard | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Try parsing as JSON identity card
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
      const obj = parsed as Record<string, unknown>
      if (
        typeof obj.id === 'string' &&
        typeof obj.ppk === 'string' &&
        typeof obj.iat === 'number' &&
        Number.isFinite(obj.iat)
      ) {
        return { id: obj.id, ppk: obj.ppk, iat: obj.iat }
      }
    }
  } catch {
    // Not JSON, continue
  }

  return null
}

// Generate random placeholder name from BIP39 words
function generateRandomName(): string {
  const words: string[] = []
  const randomBytes = crypto.getRandomValues(new Uint8Array(8)) // 4 words * 2 bytes each
  for (let i = 0; i < 4; i++) {
    const index = ((randomBytes[i * 2] << 8) | randomBytes[i * 2 + 1]) % PIN_WORDLIST.length
    words.push(PIN_WORDLIST[index])
  }
  return words.join('-')
}

export function PasskeyPage() {
  const [pageState, setPageState] = useState<PageState>('idle')
  const [activeMode, setActiveMode] = useState<ActiveMode>('idle')
  const [userName, setUserName] = useState('')
  const defaultUserName = useMemo(() => generateRandomName(), [])
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [publicIdBase64, setPublicIdBase64] = useState<string | null>(null)
  const [peerPublicKeyBase64, setPeerPublicKeyBase64] = useState<string | null>(null)
  const [identityCardIat, setIdentityCardIat] = useState<number | null>(null)
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedIdentityCard, setCopiedIdentityCard] = useState(false)

  // Pairing Key state
  const [peerInput, setPeerInput] = useState('')
  const [pairingComment, setPairingComment] = useState('')
  const [outputPairingKey, setOutputPairingKey] = useState<string | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [copiedPairingKey, setCopiedPairingKey] = useState(false)

  // QR Scanner state
  const [showQRScanner, setShowQRScanner] = useState(false)
  const [qrScannerMode, setQRScannerMode] = useState<'identity-card' | 'pairing-request'>('identity-card')
  const [qrScanError, setQRScanError] = useState<string | null>(null)
  const [outputPairingKeyQrUrl, setOutputPairingKeyQrUrl] = useState<string | null>(null)
  const [outputPairingKeyQrError, setOutputPairingKeyQrError] = useState<string | null>(null)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    isMobileDevice() ? 'environment' : 'user'
  )

  // Format fingerprint for display: XXXX-XXXX-XXXX-XXXX
  const formattedFingerprint = fingerprint ? formatFingerprint(fingerprint) : null

  // Generate identity card JSON (with 24-hour TTL)
  const identityCard: string | null =
    publicIdBase64 && peerPublicKeyBase64 && identityCardIat
      ? JSON.stringify({ id: publicIdBase64, ppk: peerPublicKeyBase64, iat: identityCardIat })
      : null


  // Auto-clear success message after 3 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  // Generate QR code URL when outputPairingKey changes
  useEffect(() => {
    let cancelled = false
    let currentUrl: string | null = null

    if (outputPairingKey) {
      // Clear previous error when retrying
      setOutputPairingKeyQrError(null)
      generateTextQRCode(outputPairingKey, { width: 256, errorCorrectionLevel: 'L' })
        .then((url) => {
          if (cancelled) {
            // Component unmounted or effect re-ran - revoke the unused URL
            URL.revokeObjectURL(url)
            return
          }
          currentUrl = url
          setOutputPairingKeyQrUrl(url)
          setOutputPairingKeyQrError(null)
        })
        .catch((err) => {
          if (cancelled) return
          console.error('Failed to generate QR code:', err)
          setOutputPairingKeyQrUrl(null)
          setOutputPairingKeyQrError(err instanceof Error ? err.message : 'Failed to generate QR code')
        })
    } else {
      setOutputPairingKeyQrUrl(null)
      setOutputPairingKeyQrError(null)
    }

    return () => {
      cancelled = true
      // Revoke blob URL on cleanup to prevent memory leaks
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl)
      }
    }
  }, [outputPairingKey])

  // QR Scanner handlers
  const handleQRScan = useCallback(
    (data: Uint8Array) => {
      try {
        // Decode Uint8Array to string (QR codes contain UTF-8 text)
        const text = new TextDecoder().decode(data)

        // Try to parse as JSON to validate format
        const parsed = JSON.parse(text)

        if (qrScannerMode === 'identity-card') {
          // Validate identity card format (support both old 'cpk' and new 'ppk')
          const hasPpk = typeof parsed.ppk === 'string' || typeof parsed.cpk === 'string'
          const hasValidIat = typeof parsed.iat === 'number'
          if (typeof parsed.id !== 'string' || !hasPpk || !hasValidIat) {
            setQRScanError('Invalid identity card format: missing "id", "ppk", or "iat"')
            return
          }
        } else {
          // Validate pairing request format (basic check)
          if (typeof parsed.a_id !== 'string' || typeof parsed.init_sig !== 'string') {
            setQRScanError('Invalid pairing request format')
            return
          }
        }

        // Success - populate input and close scanner
        setPeerInput(text)
        setShowQRScanner(false)
        setQRScanError(null)
      } catch {
        setQRScanError('Invalid QR code: not valid JSON')
      }
    },
    [qrScannerMode]
  )

  const handleQRError = useCallback((error: string) => {
    setQRScanError(error)
  }, [])

  const handleCameraReady = useCallback(() => {
    setQRScanError(null)
  }, [])

  const handleSwitchCamera = useCallback(() => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
  }, [])

  // QR Scanner hook
  const { videoRef, canvasRef, availableCameras } = useQRScanner({
    onScan: handleQRScan,
    onError: handleQRError,
    onCameraReady: handleCameraReady,
    isScanning: showQRScanner,
    facingMode,
  })

  const openQRScanner = (mode: 'identity-card' | 'pairing-request') => {
    setQRScannerMode(mode)
    setQRScanError(null)
    setShowQRScanner(true)
  }


  const handleCreatePasskey = async () => {
    setError(null)
    setSuccess(null)
    setFingerprint(null)
    setPublicIdBase64(null)
    setPeerPublicKeyBase64(null)
    setIdentityCardIat(null)
    setPrfSupported(null)
    setOutputPairingKey(null)
    setPageState('checking')

    try {
      // First check WebAuthn support
      const support = await checkWebAuthnSupport()
      if (!support.webauthnSupported) {
        setError(support.error || 'WebAuthn not supported')
        setPageState('idle')
        return
      }

      setPageState('creating')

      // Create the passkey
      await createPasskeyCredential(userName || defaultUserName)
      setUserName('') // Clear display name input after successful creation

      // Show success and let user manually authenticate
      // (Auto-authenticating immediately can fail on some authenticators like 1Password mobile)
      setSuccess('Passkey created! Choose an option below to continue.')
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create passkey')
      setPageState('idle')
    }
  }

  // Handler for "Someone wants to add me as a peer" - auth to get identity for display
  const handleSelectSigner = async () => {
    setError(null)
    setSuccess(null)
    setOutputPairingKey(null)
    setPairingError(null)
    setPeerInput('')
    setPageState('getting_key')

    try {
      const result = await getPasskeyIdentity()
      setFingerprint(result.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(result.publicIdBytes))
      setPrfSupported(result.prfSupported)

      // Store peer public key for display (signing key is NOT stored - derived fresh per sign)
      setPeerPublicKeyBase64(uint8ArrayToBase64(result.peerPublicKey))

      // Set issued-at timestamp for identity card (24-hour TTL)
      setIdentityCardIat(Math.floor(Date.now() / 1000))

      setPageState('idle')
      setActiveMode('signer')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authenticate')
      setPageState('idle')
    }
  }

  // Handler for "I want to add someone as a peer" - no auth needed, just switch mode
  const handleSelectInitiator = () => {
    setError(null)
    setSuccess(null)
    setOutputPairingKey(null)
    setPairingError(null)
    setPeerInput('')
    setPairingComment('')
    setActiveMode('initiator')
  }

  const copyToClipboard = async (text: string, onSuccess: () => void, onError: () => void) => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        onError()
        return
      }
      await navigator.clipboard.writeText(text)
      onSuccess()
    } catch {
      onError()
    }
  }

  const handleCopyIdentityCard = async () => {
    if (!identityCard) return
    await copyToClipboard(
      identityCard,
      () => {
        setCopiedIdentityCard(true)
        setTimeout(() => setCopiedIdentityCard(false), 2000)
      },
      () => {
        setError('Failed to copy to clipboard')
        setTimeout(() => setError(null), 3000)
      }
    )
  }

  const handleCopyFingerprint = async () => {
    if (!formattedFingerprint) return
    await copyToClipboard(
      formattedFingerprint,
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => {
        setError('Failed to copy to clipboard')
        setTimeout(() => setError(null), 3000)
      }
    )
  }

  const handleCreatePairingRequest = async () => {
    setPairingError(null)
    setOutputPairingKey(null)
    setPageState('pairing_peer')

    try {
      const trimmed = peerInput.trim()
      if (!trimmed) {
        throw new Error("Please enter peer's identity card")
      }

      // Parse identity card first (before auth prompt)
      const identityCardParsed = parseIdentityInput(trimmed)
      if (!identityCardParsed) {
        throw new Error('Invalid identity card format. Expected JSON with "id", "ppk", and "iat" (finite number) fields.')
      }

      // Validate identity card fields
      try {
        const idBytes = base64ToUint8Array(identityCardParsed.id)
        if (idBytes.length !== 32) {
          throw new ValidationError('Invalid peer public ID: expected 32 bytes')
        }
        const ppkBytes = base64ToUint8Array(identityCardParsed.ppk)
        if (ppkBytes.length !== 32) {
          throw new ValidationError('Invalid peer public key: expected 32 bytes')
        }
      } catch (e) {
        if (e instanceof ValidationError) {
          throw e
        }
        throw new ValidationError('Invalid base64 encoding in identity card')
      }

      // Validate identity card TTL (24 hours)
      const now = Math.floor(Date.now() / 1000)
      if (identityCardParsed.iat > now + MAX_ACCEPTABLE_CLOCK_SKEW_SECONDS) {
        throw new Error('Identity card iat is in the future. Check your device clock.')
      }
      if (now - identityCardParsed.iat > IDENTITY_CARD_TTL_SECONDS) {
        throw new Error('Identity card has expired (valid for 24 hours). Ask your peer to generate a new one.')
      }

      // Authenticate fresh to get HMAC key (key only exists during this operation)
      const identity = await getPasskeyIdentity()

      // Create pairing request using freshly derived HMAC key
      const pairingRequest = await createPairingRequest(
        identity.hmacKey,
        identity.peerPublicKey,
        uint8ArrayToBase64(identity.publicIdBytes),
        identityCardParsed.id,
        identityCardParsed.ppk,
        identityCardParsed.iat,
        pairingComment.trim() || undefined
      )
      // hmacKey goes out of scope here - no longer in memory

      setOutputPairingKey(pairingRequest)
      setPeerInput('')
      setPairingComment('')
      setPageState('idle')
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : 'Failed to create pairing request')
      setPageState('idle')
    }
  }

  const handleConfirmRequest = async () => {
    setPairingError(null)
    setOutputPairingKey(null)
    setPageState('pairing_peer')

    try {
      const trimmed = peerInput.trim()
      if (!trimmed) {
        throw new Error('Please enter pairing request')
      }

      // Validate pairing request format first (before auth prompt)
      if (!isPairingRequestFormat(trimmed)) {
        throw new Error('Invalid pairing request format')
      }

      // Authenticate fresh to get HMAC key (key only exists during this operation)
      const identity = await getPasskeyIdentity()

      const pairingKey = await confirmPairingRequest(
        trimmed,
        identity.hmacKey,
        identity.peerPublicKey,
        uint8ArrayToBase64(identity.publicIdBytes)
      )
      // hmacKey goes out of scope here - no longer in memory

      setOutputPairingKey(pairingKey)
      setPeerInput('')
      setPageState('idle')
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : 'Failed to confirm pairing request')
      setPageState('idle')
    }
  }

  const handleCopyPairingKey = async () => {
    if (!outputPairingKey) return
    await copyToClipboard(
      outputPairingKey,
      () => {
        setCopiedPairingKey(true)
        setTimeout(() => setCopiedPairingKey(false), 2000)
      },
      () => {
        setPairingError('Failed to copy to clipboard')
        setTimeout(() => setPairingError(null), 3000)
      }
    )
  }

  const handleDownloadPairingKey = (filePrefix: string) => {
    if (!outputPairingKey) return
    try {
      downloadTextFile(outputPairingKey, `${filePrefix}-${Date.now()}.json`, 'application/json')
    } catch (err) {
      console.error('Failed to download file:', err)
      setPairingError('Failed to download file')
      setTimeout(() => setPairingError(null), 3000)
    }
  }

  const handleStartOver = () => {
    setActiveMode('idle')
    setPeerInput('')
    setPairingComment('')
    setOutputPairingKey(null)
    setPairingError(null)
    // Reset display state so user must re-authenticate when selecting a new mode
    setFingerprint(null)
    setPublicIdBase64(null)
    setPeerPublicKeyBase64(null)
    setIdentityCardIat(null)
  }

  const isLoading = pageState !== 'idle'

  // Render identity card with numbered step (for signer flow step 1)
  const renderIdentityCardStep = () => {
    if (!identityCard || !fingerprint) return null

    return (
      <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20 space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan-600 text-white text-sm font-medium">
            1
          </span>
          <span className="font-semibold text-cyan-700 dark:text-cyan-400">Your Identity Card</span>
        </div>

        {/* QR Code */}
        <div className="flex flex-col items-center gap-4">
          <div className="bg-white p-4 rounded-lg">
            <QRCodeSVG value={identityCard} size={200} level="M" />
          </div>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            Share this QR code with your peer so they can create a pairing request.
          </p>
        </div>

        {/* Copy Identity Card */}
        <div className="pt-4 border-t border-cyan-500/30">
          <div className="flex items-center gap-2 mb-2">
            <Key className="h-4 w-4 text-cyan-600" />
            <span className="text-sm font-medium text-cyan-600">Identity Card (JSON)</span>
          </div>
          <div className="flex gap-2">
            <textarea
              readOnly
              value={identityCard}
              onClick={(e) => e.currentTarget.select()}
              rows={2}
              className="flex-1 text-xs bg-cyan-500/10 border border-cyan-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500/30 resize-none"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyIdentityCard}
              className={`flex-shrink-0 ${copiedIdentityCard ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-cyan-500/10'}`}
            >
              {copiedIdentityCard ? (
                <Check className="h-4 w-4 text-white" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* Fingerprint */}
        <div className="pt-4 border-t border-cyan-500/30">
          <div className="flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-cyan-600" />
            <span className="text-xs font-medium text-cyan-600">Fingerprint</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-cyan-600">
              {formattedFingerprint}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyFingerprint}
              className={`h-8 ${copied ? 'bg-emerald-500 hover:bg-emerald-500' : 'hover:bg-cyan-500/10'}`}
            >
              {copied ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Use to verify identity when sharing your identity card.
          </p>
        </div>

        {prfSupported === false && (
          <p className="text-xs text-amber-600">
            Warning: This passkey does not support the PRF extension required for encryption.
          </p>
        )}
      </div>
    )
  }

  // Render Create Passkey section
  const renderCreatePasskeySection = () => (
    <div className="space-y-4 p-4 rounded-lg border-2 border-primary/30 bg-primary/5">
      <h3 className="text-lg font-semibold flex items-center gap-2">
        <Plus className="h-5 w-5" />
        Create New Passkey
      </h3>
      <p className="text-sm">
        Create a passkey to generate your identity card. Share it with peers for secure file
        transfers without needing PINs.
      </p>
      <div className="space-y-2">
        <Label htmlFor="userName">Display Name</Label>
        <Input
          id="userName"
          placeholder={defaultUserName}
          value={userName}
          onChange={(e) => setUserName(e.target.value)}
          disabled={isLoading}
        />
        <p className="text-xs text-muted-foreground">
          Helps identify this passkey in your password manager.
        </p>
      </div>
      <Button onClick={handleCreatePasskey} disabled={isLoading} className="w-full" size="lg">
        {pageState !== 'idle' ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {pageState === 'checking' && 'Checking support...'}
            {pageState === 'creating' && 'Creating passkey...'}
            {pageState === 'getting_key' && 'Getting public ID...'}
          </>
        ) : (
          <>
            <Plus className="mr-2 h-4 w-4" />
            Create Passkey
          </>
        )}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        Two prompts are expected: first to create the passkey, then to authenticate and derive
        your public ID.
      </p>
    </div>
  )

  // Render "Already Have a Passkey?" section with mode selection
  const renderAlreadyHavePasskeySection = () => (
    <div className="space-y-4 p-4 rounded-lg border">
      <h3 className="font-medium flex items-center gap-2">
        <Key className="h-4 w-4" />
        Already Have a Passkey?
      </h3>
      <p className="text-sm text-muted-foreground">
        Choose what you want to do to create a pairing key.
      </p>

      <div className="grid gap-3">
        <Button
          onClick={handleSelectSigner}
          className="h-auto py-4 flex flex-col items-start gap-1"
          variant="outline"
          disabled={isLoading}
        >
          {pageState === 'getting_key' ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Authenticating...</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 font-semibold">
                <Plus className="h-5 w-5" />
                I want to pair with someone
              </div>
              <p className="text-xs text-muted-foreground font-normal text-left whitespace-normal">
                Share your identity card first, then confirm their pairing request
              </p>
            </>
          )}
        </Button>

        <Button
          onClick={handleSelectInitiator}
          className="h-auto py-4 flex flex-col items-start gap-1"
          variant="outline"
          disabled={isLoading}
        >
          {pageState === 'getting_key' ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Authenticating...</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-5 w-5" />
                I have someone's identity card
              </div>
              <p className="text-xs text-muted-foreground font-normal text-left">
                Create a pairing request for them to confirm
              </p>
            </>
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center pt-2">
        Already have a pairing key?{' '}
        <Link to="/passkey/verify-token" className="text-primary hover:underline">
          Verify it here
        </Link>
      </p>
    </div>
  )

  // Render idle state (create passkey + already have passkey)
  const renderIdleState = () => (
    <div className="space-y-6">
      {renderCreatePasskeySection()}
      {renderAlreadyHavePasskeySection()}
    </div>
  )

  // Initiator flow: Create Pairing Request
  const renderInitiatorFlow = () => (
    <div className="space-y-6">
      {/* Back button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleStartOver}
        className="text-muted-foreground"
        disabled={isLoading}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      {/* Pairing request creation form */}
      <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10">
        <h3 className="font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-600" />
          Create Pairing Request
        </h3>
        <p className="text-sm text-muted-foreground">
          Paste your peer&apos;s identity card to create a pairing request for them to confirm.
        </p>

        <div className="space-y-2">
          <Label htmlFor="identity-card">Peer&apos;s Identity Card</Label>
          <div className="flex gap-2">
            <Textarea
              id="identity-card"
              placeholder={`Paste peer's identity card (JSON with "id" and "ppk")...`}
              value={peerInput}
              onChange={(e) => setPeerInput(e.target.value)}
              disabled={isLoading}
              className="font-mono text-xs min-h-[60px] resize-none flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => openQRScanner('identity-card')}
              disabled={isLoading}
              className="flex-shrink-0"
              title="Scan QR code"
            >
              <Camera className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pairing-comment">Comment (optional)</Label>
          <Input
            id="pairing-comment"
            placeholder="e.g., Alice's work laptop"
            value={pairingComment}
            onChange={(e) => setPairingComment(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <Button
          onClick={handleCreatePairingRequest}
          disabled={!peerInput.trim() || isLoading}
          className="w-full"
        >
          {pageState === 'pairing_peer' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Shield className="mr-2 h-4 w-4" />
              Create Pairing Request
            </>
          )}
        </Button>

        {pairingError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{pairingError}</AlertDescription>
          </Alert>
        )}

        {outputPairingKey && (
          <div className="space-y-3 pt-3 border-t border-amber-500/30">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium text-green-600">Pairing Request Created</span>
            </div>

            {/* QR Code for pairing request */}
            {outputPairingKeyQrUrl && (
              <div className="flex flex-col items-center gap-2">
                <div className="bg-white p-3 rounded-lg">
                  <img src={outputPairingKeyQrUrl} alt="Pairing Request QR Code" className="w-48 h-48" />
                </div>
                <span className="text-xs font-medium text-amber-600 bg-amber-100 px-2 py-0.5 rounded">
                  Pairing Request
                </span>
                <p className="text-xs text-muted-foreground">
                  Let your peer scan this QR code
                </p>
              </div>
            )}
            {outputPairingKeyQrError && (
              <div className="flex flex-col items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive">QR code generation failed: {outputPairingKeyQrError}</p>
                <p className="text-xs text-muted-foreground">Copy the text below instead</p>
              </div>
            )}

            <div className="flex gap-2">
              <Textarea
                readOnly
                value={outputPairingKey}
                onClick={(e) => e.currentTarget.select()}
                rows={4}
                className="flex-1 text-xs bg-amber-500/10 border border-amber-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
              />
              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyPairingKey}
                  className={`flex-shrink-0 ${copiedPairingKey ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-amber-500/10'}`}
                >
                  {copiedPairingKey ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownloadPairingKey('pairing-request')}
                  className="flex-shrink-0 hover:bg-amber-500/10"
                  aria-label="Download pairing request"
                  title="Download pairing request"
                >
                  <Download className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <Alert className="bg-blue-50 border-blue-200">
              <Info className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 text-xs">
                This can be shared publicly — it contains no secrets, only public identifiers and
                your digital signature.
              </AlertDescription>
            </Alert>

            <p className="text-xs text-muted-foreground">
              Send this pairing request to your peer. They will confirm it and send back the final
              pairing key.
            </p>
            <Button variant="outline" onClick={handleStartOver} className="w-full">
              Start Over
            </Button>
          </div>
        )}
      </div>
    </div>
  )

  // Signer flow: Show identity card + confirm pairing request (with numbered steps)
  const renderSignerFlow = () => (
    <div className="space-y-6">
      {/* Back button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleStartOver}
        className="text-muted-foreground"
        disabled={isLoading}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      {/* Step 1: Identity Card */}
      {renderIdentityCardStep()}

      {/* Step 2: Instructions */}
      <div className="p-4 rounded-lg border border-muted bg-muted/30">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted-foreground/50 text-white text-sm font-medium">
            2
          </span>
          <span className="font-semibold text-muted-foreground">Wait for Pairing Request</span>
        </div>
        <p className="text-sm text-muted-foreground ml-8">
          Ask your peer to scan your identity card above and create a pairing request. They will
          send it back to you.
        </p>
      </div>

      {/* Step 3: Confirm Pairing Request */}
      <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-600 text-white text-sm font-medium">
            3
          </span>
          <span className="font-semibold text-amber-700 dark:text-amber-400">
            Confirm Pairing Request
          </span>
        </div>
        <p className="text-sm text-muted-foreground ml-8">
          Paste the pairing request your peer sent you to create the pairing key.
        </p>

        <div className="space-y-2">
          <Label htmlFor="pairing-request">Pairing Request</Label>
          <div className="flex gap-2">
            <Textarea
              id="pairing-request"
              placeholder="Paste the pairing request from your peer..."
              value={peerInput}
              onChange={(e) => setPeerInput(e.target.value)}
              disabled={isLoading}
              className="font-mono text-xs min-h-[80px] resize-none flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => openQRScanner('pairing-request')}
              disabled={isLoading}
              className="flex-shrink-0"
              title="Scan QR code"
            >
              <Camera className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Button
          onClick={handleConfirmRequest}
          disabled={!peerInput.trim() || isLoading}
          className="w-full"
        >
          {pageState === 'pairing_peer' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Confirming...
            </>
          ) : (
            <>
              <Shield className="mr-2 h-4 w-4" />
              Confirm Pairing Request
            </>
          )}
        </Button>

        {pairingError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{pairingError}</AlertDescription>
          </Alert>
        )}

        {outputPairingKey && (
          <div className="space-y-3 pt-3 border-t border-amber-500/30">
            {/* Step 4: Share with Your Peer */}
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-600 text-white text-xs font-medium">4</span>
              <span className="font-medium">Share with Your Peer</span>
            </div>

            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium text-green-600">Pairing Key Completed</span>
            </div>

            {/* QR Code for pairing key */}
            {outputPairingKeyQrUrl && (
              <div className="flex flex-col items-center gap-2">
                <div className="bg-white p-3 rounded-lg">
                  <img src={outputPairingKeyQrUrl} alt="Pairing Key QR Code" className="w-48 h-48" />
                </div>
                <span className="text-xs font-medium text-green-600 bg-green-100 px-2 py-0.5 rounded">
                  Pairing Key
                </span>
                <p className="text-xs text-muted-foreground">
                  Share this QR code with your peer
                </p>
              </div>
            )}
            {outputPairingKeyQrError && (
              <div className="flex flex-col items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive">QR code generation failed: {outputPairingKeyQrError}</p>
                <p className="text-xs text-muted-foreground">Copy the text below instead</p>
              </div>
            )}

            <div className="flex gap-2">
              <Textarea
                readOnly
                value={outputPairingKey}
                onClick={(e) => e.currentTarget.select()}
                rows={4}
                className="flex-1 text-xs bg-amber-500/10 border border-amber-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
              />
              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyPairingKey}
                  className={`flex-shrink-0 ${copiedPairingKey ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-amber-500/10'}`}
                >
                  {copiedPairingKey ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownloadPairingKey('pairing-key')}
                  className="flex-shrink-0 hover:bg-amber-500/10"
                  aria-label="Download pairing key"
                  title="Download pairing key"
                >
                  <Download className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <Alert className="bg-blue-50 border-blue-200">
              <Info className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 text-xs">
                This pairing key can be shared publicly — it contains no secrets, only public
                identifiers and digital signatures proving mutual consent. Both you and your peer
                need this same key for secure transfers.
              </AlertDescription>
            </Alert>

            <Button variant="outline" onClick={handleStartOver} className="w-full">
              Start Over
            </Button>
          </div>
        )}
      </div>
    </div>
  )

  // Render content based on active mode
  const renderContent = () => {
    switch (activeMode) {
      case 'signer':
        return renderSignerFlow()
      case 'initiator':
        return renderInitiatorFlow()
      default:
        return renderIdleState()
    }
  }

  return (
    <div className="flex w-full justify-center">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-2xl flex items-center gap-2">
            <Fingerprint className="h-6 w-6" />
            Passkey Setup
          </CardTitle>
          <CardDescription>
            Generate your passkey identity card for secure, PIN-free file transfers
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Error alert */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success alert */}
          {success && (
            <Alert className="border-green-500/50 bg-green-50/50 dark:bg-green-950/20">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertTitle className="text-green-600">Success</AlertTitle>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          {/* Main content based on active mode */}
          {renderContent()}

          {/* Technical details */}
          <div className="text-xs text-muted-foreground space-y-1 border-t pt-4">
            <p>
              <span className="font-medium text-foreground">How it works:</span> Your passkey derives
              a non-extractable master key via the WebAuthn PRF extension. A shareable public ID and
              fingerprint are derived with HKDF. Transfers use ephemeral ECDH session keys plus
              passkey-bound session binding, ensuring only the intended recipient can decrypt.
            </p>
            <p>
              <span className="font-medium text-foreground">Pairing keys:</span> Both parties sign
              the same key, proving mutual consent. The initiator creates a pairing request, and the
              peer confirms it to produce the final pairing key.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* QR Scanner Modal */}
      {showQRScanner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-background rounded-lg p-4 max-w-sm w-full mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium flex items-center gap-2">
                <Camera className="h-5 w-5" />
                {qrScannerMode === 'identity-card' ? 'Scan Identity Card' : 'Scan Pairing Request'}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowQRScanner(false)
                  setQRScanError(null)
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="relative bg-black rounded-lg overflow-hidden aspect-square">
              {qrScanError && (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/90 p-4 z-10">
                  <div className="text-center">
                    <AlertCircle className="h-8 w-8 mx-auto text-destructive mb-2" />
                    <p className="text-sm text-destructive">{qrScanError}</p>
                  </div>
                </div>
              )}

              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />
              <canvas ref={canvasRef} className="hidden" />

              {/* Scanning overlay */}
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-8 border-2 border-white/50 rounded-lg" />
              </div>
            </div>

            {availableCameras.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSwitchCamera}
                className="w-full"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Switch Camera
              </Button>
            )}

            <p className="text-xs text-muted-foreground text-center">
              {qrScannerMode === 'identity-card'
                ? 'Point camera at the identity card QR code'
                : 'Point camera at the pairing request QR code'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
