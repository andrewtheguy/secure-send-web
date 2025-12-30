import { useState, useMemo, useEffect, useCallback } from 'react'
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
  createMutualTokenInit,
  countersignMutualToken,
  isTokenRequest,
} from '@/lib/crypto/contact-token'
import { PIN_WORDLIST } from '@/lib/crypto/constants'
import { ValidationError } from '@/lib/errors'
import { useQRScanner } from '@/hooks/useQRScanner'
import { generateTextQRCode } from '@/lib/qr-utils'
import { isMobileDevice } from '@/lib/utils'

type PageState = 'idle' | 'checking' | 'creating' | 'getting_key' | 'binding_contact'

// Active mode for "Already Have a Passkey?" section
type ActiveMode = 'idle' | 'signer' | 'initiator'

// Contact card format: JSON with id (public ID) and cpk (credential public key)
interface ContactCard {
  id: string // base64 public ID (32 bytes)
  cpk: string // base64 credential public key (65 bytes)
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

// Parse a contact card from JSON format
function parseContactInput(input: string): ContactCard | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Try parsing as JSON contact card first
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      'cpk' in parsed &&
      typeof (parsed as ContactCard).id === 'string' &&
      typeof (parsed as ContactCard).cpk === 'string'
    ) {
      return parsed as ContactCard
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
  const [contactPublicKeyBase64, setContactPublicKeyBase64] = useState<string | null>(null)
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedContactCard, setCopiedContactCard] = useState(false)

  // Mutual Token state
  const [contactInput, setContactInput] = useState('')
  const [tokenComment, setTokenComment] = useState('')
  const [outputToken, setOutputToken] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState(false)

  // QR Scanner state
  const [showQRScanner, setShowQRScanner] = useState(false)
  const [qrScannerMode, setQRScannerMode] = useState<'contact-card' | 'token-request'>('contact-card')
  const [qrScanError, setQRScanError] = useState<string | null>(null)
  const [outputTokenQrUrl, setOutputTokenQrUrl] = useState<string | null>(null)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    isMobileDevice() ? 'environment' : 'user'
  )

  // Format fingerprint for display: XXXX-XXXX-XXXX-XXXX
  const formattedFingerprint = fingerprint ? formatFingerprint(fingerprint) : null

  // Generate contact card JSON
  const contactCard: string | null =
    publicIdBase64 && contactPublicKeyBase64
      ? JSON.stringify({ id: publicIdBase64, cpk: contactPublicKeyBase64 })
      : null


  // Auto-clear success message after 3 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  // Generate QR code URL when outputToken changes
  useEffect(() => {
    if (outputToken) {
      generateTextQRCode(outputToken, { width: 256, errorCorrectionLevel: 'L' })
        .then(setOutputTokenQrUrl)
        .catch((err) => console.error('Failed to generate QR code:', err))
    } else {
      setOutputTokenQrUrl(null)
    }
  }, [outputToken])

  // QR Scanner handlers
  const handleQRScan = useCallback(
    (data: Uint8Array) => {
      try {
        // Decode Uint8Array to string (QR codes contain UTF-8 text)
        const text = new TextDecoder().decode(data)

        // Try to parse as JSON to validate format
        const parsed = JSON.parse(text)

        if (qrScannerMode === 'contact-card') {
          // Validate contact card format
          if (typeof parsed.id !== 'string' || typeof parsed.cpk !== 'string') {
            setQRScanError('Invalid contact card format: missing "id" or "cpk"')
            return
          }
        } else {
          // Validate token request format (basic check)
          if (typeof parsed.a_id !== 'string' || typeof parsed.init_sig !== 'string') {
            setQRScanError('Invalid token request format')
            return
          }
        }

        // Success - populate input and close scanner
        setContactInput(text)
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

  const openQRScanner = (mode: 'contact-card' | 'token-request') => {
    setQRScannerMode(mode)
    setQRScanError(null)
    setShowQRScanner(true)
  }


  const handleCreatePasskey = async () => {
    setError(null)
    setSuccess(null)
    setFingerprint(null)
    setPublicIdBase64(null)
    setContactPublicKeyBase64(null)
    setPrfSupported(null)
    setOutputToken(null)
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

  // Handler for "Someone wants to add me as a contact" - auth to get identity for display
  const handleSelectSigner = async () => {
    setError(null)
    setSuccess(null)
    setOutputToken(null)
    setTokenError(null)
    setContactInput('')
    setPageState('getting_key')

    try {
      const result = await getPasskeyIdentity()
      setFingerprint(result.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(result.publicIdBytes))
      setPrfSupported(result.prfSupported)

      // Store contact public key for display (signing key is NOT stored - derived fresh per sign)
      setContactPublicKeyBase64(uint8ArrayToBase64(result.contactPublicKey))

      setPageState('idle')
      setActiveMode('signer')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authenticate')
      setPageState('idle')
    }
  }

  // Handler for "I want to add someone as a contact" - auth to get identity for display
  const handleSelectInitiator = async () => {
    setError(null)
    setSuccess(null)
    setOutputToken(null)
    setTokenError(null)
    setContactInput('')
    setTokenComment('')
    setPageState('getting_key')

    try {
      const result = await getPasskeyIdentity()
      setFingerprint(result.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(result.publicIdBytes))
      setPrfSupported(result.prfSupported)

      // Store contact public key for display (signing key is NOT stored - derived fresh per sign)
      setContactPublicKeyBase64(uint8ArrayToBase64(result.contactPublicKey))

      setPageState('idle')
      setActiveMode('initiator')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authenticate')
      setPageState('idle')
    }
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

  const handleCopyContactCard = async () => {
    if (!contactCard) return
    await copyToClipboard(
      contactCard,
      () => {
        setCopiedContactCard(true)
        setTimeout(() => setCopiedContactCard(false), 2000)
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

  const handleCreateToken = async () => {
    setTokenError(null)
    setOutputToken(null)
    setPageState('binding_contact')

    try {
      const trimmed = contactInput.trim()
      if (!trimmed) {
        throw new Error("Please enter contact's card")
      }

      // Parse contact card first (before auth prompt)
      const contactCardParsed = parseContactInput(trimmed)
      if (!contactCardParsed) {
        throw new Error('Invalid contact card format. Expected JSON with "id" and "cpk" fields.')
      }

      // Validate contact card fields
      try {
        const idBytes = base64ToUint8Array(contactCardParsed.id)
        if (idBytes.length !== 32) {
          throw new ValidationError('Invalid contact public ID: expected 32 bytes')
        }
        const cpkBytes = base64ToUint8Array(contactCardParsed.cpk)
        if (cpkBytes.length !== 65 || cpkBytes[0] !== 0x04) {
          throw new ValidationError('Invalid contact public key: expected 65-byte P-256')
        }
      } catch (e) {
        if (e instanceof ValidationError) {
          throw e
        }
        throw new ValidationError('Invalid base64 encoding in contact card')
      }

      // Authenticate fresh to get signing key (key only exists during this operation)
      const identity = await getPasskeyIdentity()

      // Create pending mutual token using freshly derived signing key
      const token = await createMutualTokenInit(
        identity.contactSigningKey,
        identity.contactPublicKey,
        uint8ArrayToBase64(identity.publicIdBytes),
        contactCardParsed.id,
        contactCardParsed.cpk,
        tokenComment.trim() || undefined
      )
      // contactSigningKey goes out of scope here - no longer in memory

      setOutputToken(token)
      setContactInput('')
      setTokenComment('')
      setPageState('idle')
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to create token')
      setPageState('idle')
    }
  }

  const handleSignRequest = async () => {
    setTokenError(null)
    setOutputToken(null)
    setPageState('binding_contact')

    try {
      const trimmed = contactInput.trim()
      if (!trimmed) {
        throw new Error('Please enter token request')
      }

      // Validate token request format first (before auth prompt)
      if (!isTokenRequest(trimmed)) {
        throw new Error('Invalid token request format')
      }

      // Authenticate fresh to get signing key (key only exists during this operation)
      const identity = await getPasskeyIdentity()

      const token = await countersignMutualToken(
        trimmed,
        identity.contactSigningKey,
        identity.contactPublicKey,
        uint8ArrayToBase64(identity.publicIdBytes)
      )
      // contactSigningKey goes out of scope here - no longer in memory

      setOutputToken(token)
      setContactInput('')
      setPageState('idle')
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to sign token request')
      setPageState('idle')
    }
  }

  const handleCopyToken = async () => {
    if (!outputToken) return
    await copyToClipboard(
      outputToken,
      () => {
        setCopiedToken(true)
        setTimeout(() => setCopiedToken(false), 2000)
      },
      () => {
        setTokenError('Failed to copy to clipboard')
        setTimeout(() => setTokenError(null), 3000)
      }
    )
  }

  const handleStartOver = () => {
    setActiveMode('idle')
    setContactInput('')
    setTokenComment('')
    setOutputToken(null)
    setTokenError(null)
    // Reset display state so user must re-authenticate when selecting a new mode
    setFingerprint(null)
    setPublicIdBase64(null)
    setContactPublicKeyBase64(null)
  }

  const isLoading = pageState !== 'idle'

  // Render contact card with numbered step (for signer flow step 1)
  const renderContactCardStep = () => {
    if (!contactCard || !fingerprint) return null

    return (
      <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20 space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan-600 text-white text-sm font-medium">
            1
          </span>
          <span className="font-semibold text-cyan-700 dark:text-cyan-400">Your Contact Card</span>
        </div>

        {/* QR Code */}
        <div className="flex flex-col items-center gap-4">
          <div className="bg-white p-4 rounded-lg">
            <QRCodeSVG value={contactCard} size={200} level="M" />
          </div>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            Share this QR code with your contact so they can create a token request.
          </p>
        </div>

        {/* Copy Contact Card */}
        <div className="pt-4 border-t border-cyan-500/30">
          <div className="flex items-center gap-2 mb-2">
            <Key className="h-4 w-4 text-cyan-600" />
            <span className="text-sm font-medium text-cyan-600">Contact Card (JSON)</span>
          </div>
          <div className="flex gap-2">
            <textarea
              readOnly
              value={contactCard}
              onClick={(e) => e.currentTarget.select()}
              rows={2}
              className="flex-1 text-xs bg-cyan-500/10 border border-cyan-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500/30 resize-none"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyContactCard}
              className={`flex-shrink-0 ${copiedContactCard ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-cyan-500/10'}`}
            >
              {copiedContactCard ? (
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
            Use to verify identity when sharing your contact card.
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
        Create a passkey to generate your contact card. Share it with contacts for secure file
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
        Choose what you want to do to create a mutual contact token.
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
                <CheckCircle2 className="h-5 w-5" />
                Someone wants to add me as a contact
              </div>
              <p className="text-xs text-muted-foreground font-normal text-left whitespace-normal">
                Share your contact card, have them create a token request, then sign it
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
                <Plus className="h-5 w-5" />
                I want to add someone as a contact
              </div>
              <p className="text-xs text-muted-foreground font-normal text-left">
                You have their contact card and will create a token request for them to sign
              </p>
            </>
          )}
        </Button>
      </div>
    </div>
  )

  // Render idle state (create passkey + already have passkey)
  const renderIdleState = () => (
    <div className="space-y-6">
      {renderCreatePasskeySection()}
      {renderAlreadyHavePasskeySection()}
    </div>
  )

  // Initiator flow: Create Token Request
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

      {/* Token request creation form */}
      <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10">
        <h3 className="font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-600" />
          Create Token Request
        </h3>
        <p className="text-sm text-muted-foreground">
          Paste your contact&apos;s card to create a token request for them to sign.
        </p>

        <div className="space-y-2">
          <Label htmlFor="contact-card">Contact&apos;s Card</Label>
          <div className="flex gap-2">
            <Textarea
              id="contact-card"
              placeholder={`Paste contact's card (JSON with "id" and "cpk")...`}
              value={contactInput}
              onChange={(e) => setContactInput(e.target.value)}
              disabled={isLoading}
              className="font-mono text-xs min-h-[60px] resize-none flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => openQRScanner('contact-card')}
              disabled={isLoading}
              className="flex-shrink-0"
              title="Scan QR code"
            >
              <Camera className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="token-comment">Comment (optional)</Label>
          <Input
            id="token-comment"
            placeholder="e.g., Alice's work laptop"
            value={tokenComment}
            onChange={(e) => setTokenComment(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <Button
          onClick={handleCreateToken}
          disabled={!contactInput.trim() || isLoading}
          className="w-full"
        >
          {pageState === 'binding_contact' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Shield className="mr-2 h-4 w-4" />
              Create Token Request
            </>
          )}
        </Button>

        {tokenError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{tokenError}</AlertDescription>
          </Alert>
        )}

        {outputToken && (
          <div className="space-y-3 pt-3 border-t border-amber-500/30">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium text-green-600">Token Request Created</span>
            </div>

            {/* QR Code for token request */}
            {outputTokenQrUrl && (
              <div className="flex flex-col items-center gap-2">
                <div className="bg-white p-3 rounded-lg">
                  <img src={outputTokenQrUrl} alt="Token Request QR Code" className="w-48 h-48" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Let your contact scan this QR code
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <Textarea
                readOnly
                value={outputToken}
                onClick={(e) => e.currentTarget.select()}
                rows={4}
                className="flex-1 text-xs bg-amber-500/10 border border-amber-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyToken}
                className={`flex-shrink-0 ${copiedToken ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-amber-500/10'}`}
              >
                {copiedToken ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Send this token request to your contact. They will sign it and send back the final
              mutual token.
            </p>
            <Button variant="outline" onClick={handleStartOver} className="w-full">
              Start Over
            </Button>
          </div>
        )}
      </div>
    </div>
  )

  // Signer flow: Show contact card + sign token request (with numbered steps)
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

      {/* Step 1: Contact Card */}
      {renderContactCardStep()}

      {/* Step 2: Instructions */}
      <div className="p-4 rounded-lg border border-muted bg-muted/30">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted-foreground/50 text-white text-sm font-medium">
            2
          </span>
          <span className="font-semibold text-muted-foreground">Wait for Token Request</span>
        </div>
        <p className="text-sm text-muted-foreground ml-8">
          Ask your contact to scan your contact card above and create a token request. They will
          send it back to you.
        </p>
      </div>

      {/* Step 3: Sign Token Request */}
      <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-600 text-white text-sm font-medium">
            3
          </span>
          <span className="font-semibold text-amber-700 dark:text-amber-400">
            Sign Token Request
          </span>
        </div>
        <p className="text-sm text-muted-foreground ml-8">
          Paste the token request your contact sent you to create the mutual token.
        </p>

        <div className="space-y-2">
          <Label htmlFor="token-request">Token Request</Label>
          <div className="flex gap-2">
            <Textarea
              id="token-request"
              placeholder="Paste the token request from your contact..."
              value={contactInput}
              onChange={(e) => setContactInput(e.target.value)}
              disabled={isLoading}
              className="font-mono text-xs min-h-[80px] resize-none flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => openQRScanner('token-request')}
              disabled={isLoading}
              className="flex-shrink-0"
              title="Scan QR code"
            >
              <Camera className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Button
          onClick={handleSignRequest}
          disabled={!contactInput.trim() || isLoading}
          className="w-full"
        >
          {pageState === 'binding_contact' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Signing...
            </>
          ) : (
            <>
              <Shield className="mr-2 h-4 w-4" />
              Sign Token Request
            </>
          )}
        </Button>

        {tokenError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{tokenError}</AlertDescription>
          </Alert>
        )}

        {outputToken && (
          <div className="space-y-3 pt-3 border-t border-amber-500/30">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium text-green-600">Mutual Token Completed</span>
            </div>

            {/* QR Code for mutual token */}
            {outputTokenQrUrl && (
              <div className="flex flex-col items-center gap-2">
                <div className="bg-white p-3 rounded-lg">
                  <img src={outputTokenQrUrl} alt="Mutual Token QR Code" className="w-48 h-48" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Share this QR code with your contact
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <Textarea
                readOnly
                value={outputToken}
                onClick={(e) => e.currentTarget.select()}
                rows={4}
                className="flex-1 text-xs bg-amber-500/10 border border-amber-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyToken}
                className={`flex-shrink-0 ${copiedToken ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-amber-500/10'}`}
              >
                {copiedToken ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This mutual token can now be used by both parties for secure file transfers.
            </p>
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
            Generate your passkey contact card for secure, PIN-free file transfers
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
              <span className="font-medium text-foreground">Mutual tokens:</span> Both parties sign
              the same token, proving mutual consent. The initiator creates a token request, and the
              counterparty signs it to produce the final mutual token.
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
                {qrScannerMode === 'contact-card' ? 'Scan Contact Card' : 'Scan Token Request'}
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
              {qrScannerMode === 'contact-card'
                ? 'Point camera at the contact card QR code'
                : 'Point camera at the token request QR code'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
