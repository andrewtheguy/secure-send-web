import { useState, useMemo } from 'react'
import {
  Fingerprint,
  Plus,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Copy,
  Check,
  Key,
  QrCode,
  Shield,
  ArrowLeft,
  ArrowRight,
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
  getCredentialPublicKey,
} from '@/lib/crypto/passkey'
import { formatFingerprint } from '@/lib/crypto/ecdh'
import {
  createMutualTokenInit,
  countersignMutualToken,
  isPendingMutualToken,
} from '@/lib/crypto/contact-token'
import { PIN_WORDLIST } from '@/lib/crypto/constants'

type PageState = 'idle' | 'checking' | 'creating' | 'getting_key' | 'binding_contact'

type WizardStep =
  | 'authenticate' // Step 1
  | 'mode-select' // Step 2: Choose role
  | 'create-token' // Step 3A: Initiator flow (includes contact card)
  | 'complete-token' // Step 3B: Non-initiator flow (includes contact card)

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
  const [wizardStep, setWizardStep] = useState<WizardStep>('authenticate')
  const [userName, setUserName] = useState('')
  const defaultUserName = useMemo(() => generateRandomName(), [])
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [publicIdBase64, setPublicIdBase64] = useState<string | null>(null)
  const [credentialPublicKeyBase64, setCredentialPublicKeyBase64] = useState<string | null>(null)
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null)
  const [currentCredentialId, setCurrentCredentialId] = useState<string | null>(null)
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

  // Format fingerprint for display: XXXX-XXXX-XXXX-XXXX
  const formattedFingerprint = fingerprint ? formatFingerprint(fingerprint) : null

  // Generate contact card JSON
  const contactCard: string | null =
    publicIdBase64 && credentialPublicKeyBase64
      ? JSON.stringify({ id: publicIdBase64, cpk: credentialPublicKeyBase64 })
      : null

  // Check if authenticated (has contact card)
  const isAuthenticated = !!contactCard && !!fingerprint

  // Determine step number for display
  const getStepNumber = (step: WizardStep): number => {
    if (step === 'authenticate') return 1
    if (step === 'mode-select') return 2
    return 3
  }

  // Get step 3 label based on current mode
  const getStep3Label = (): string => {
    if (wizardStep === 'create-token') return 'Create Token'
    if (wizardStep === 'complete-token') return 'Complete Token'
    return 'Token'
  }

  const handleCreatePasskey = async () => {
    setError(null)
    setSuccess(null)
    setFingerprint(null)
    setPublicIdBase64(null)
    setCredentialPublicKeyBase64(null)
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

      // Create the passkey (also stores credential public key)
      const { credentialId } = await createPasskeyCredential(userName || defaultUserName)
      setUserName('') // Clear display name input after successful creation
      setCurrentCredentialId(credentialId)

      // Get the credential public key
      const cpk = getCredentialPublicKey(credentialId)
      if (cpk) {
        setCredentialPublicKeyBase64(uint8ArrayToBase64(cpk))
      }

      // Immediately authenticate with the new credential to get the public ID (skips picker)
      setPageState('getting_key')
      const identity = await getPasskeyIdentity(credentialId)
      setFingerprint(identity.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(identity.publicIdBytes))
      setPrfSupported(identity.prfSupported)
      setSuccess('Passkey created successfully!')
      setPageState('idle')

      // Auto-advance to mode selection
      setWizardStep('mode-select')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create passkey')
      setPageState('idle')
    }
  }

  const handleGetPublicId = async () => {
    setError(null)
    setSuccess(null)
    setOutputToken(null)
    setPageState('getting_key')

    try {
      const result = await getPasskeyIdentity()
      setFingerprint(result.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(result.publicIdBytes))
      setPrfSupported(result.prfSupported)
      setCurrentCredentialId(result.credentialId)

      // Get the credential public key
      const cpk = getCredentialPublicKey(result.credentialId)
      if (cpk) {
        setCredentialPublicKeyBase64(uint8ArrayToBase64(cpk))
      }

      setSuccess('Authenticated successfully!')
      setPageState('idle')

      // Auto-advance to mode selection
      setWizardStep('mode-select')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get public ID')
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

      if (!currentCredentialId) {
        throw new Error('Please create or authenticate with a passkey first')
      }

      const credentialPublicKey = getCredentialPublicKey(currentCredentialId)
      if (!credentialPublicKey) {
        throw new Error('Credential public key not found. Please create a new passkey.')
      }

      if (!publicIdBase64) {
        throw new Error('Please authenticate with a passkey first to get your public ID')
      }

      // Parse contact card
      const contactCardParsed = parseContactInput(trimmed)
      if (!contactCardParsed) {
        throw new Error('Invalid contact card format. Expected JSON with "id" and "cpk" fields.')
      }

      // Validate contact card fields
      try {
        const idBytes = base64ToUint8Array(contactCardParsed.id)
        if (idBytes.length !== 32) {
          throw new Error('Invalid contact public ID: expected 32 bytes')
        }
        const cpkBytes = base64ToUint8Array(contactCardParsed.cpk)
        if (cpkBytes.length !== 65 || cpkBytes[0] !== 0x04) {
          throw new Error('Invalid contact credential key: expected 65-byte P-256')
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Invalid')) {
          throw e
        }
        throw new Error('Invalid base64 encoding in contact card')
      }

      // Create pending mutual token
      const token = await createMutualTokenInit(
        currentCredentialId,
        credentialPublicKey,
        publicIdBase64,
        contactCardParsed.id,
        contactCardParsed.cpk,
        tokenComment.trim() || undefined
      )

      setOutputToken(token)
      setContactInput('')
      setTokenComment('')
      setPageState('idle')
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to create token')
      setPageState('idle')
    }
  }

  const handleCompleteToken = async () => {
    setTokenError(null)
    setOutputToken(null)
    setPageState('binding_contact')

    try {
      const trimmed = contactInput.trim()
      if (!trimmed) {
        throw new Error('Please enter pending token')
      }

      if (!currentCredentialId) {
        throw new Error('Please create or authenticate with a passkey first')
      }

      const credentialPublicKey = getCredentialPublicKey(currentCredentialId)
      if (!credentialPublicKey) {
        throw new Error('Credential public key not found. Please create a new passkey.')
      }

      if (!publicIdBase64) {
        throw new Error('Please authenticate with a passkey first to get your public ID')
      }

      if (!isPendingMutualToken(trimmed)) {
        throw new Error('Invalid pending token format')
      }

      const token = await countersignMutualToken(
        trimmed,
        currentCredentialId,
        credentialPublicKey,
        publicIdBase64
      )

      setOutputToken(token)
      setContactInput('')
      setPageState('idle')
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to complete token')
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
    setWizardStep('mode-select')
    setContactInput('')
    setTokenComment('')
    setOutputToken(null)
    setTokenError(null)
  }

  const isLoading = pageState !== 'idle'
  const currentStepNumber = getStepNumber(wizardStep)

  // Render step indicator
  const renderStepIndicator = () => {
    const steps = [
      { num: 1, label: 'Authenticate' },
      { num: 2, label: 'Choose Role' },
      { num: 3, label: getStep3Label() },
    ]

    return (
      <div className="flex items-center justify-center gap-2 mb-6">
        {steps.map((step, index) => {
          const isCompleted = step.num < currentStepNumber
          const isCurrent = step.num === currentStepNumber
          const canClick = isCompleted || (step.num === 1 && isAuthenticated)

          return (
            <div key={step.num} className="flex items-center">
              <button
                type="button"
                onClick={() => {
                  if (step.num === 1 && isAuthenticated) {
                    // Re-authenticate
                    handleGetPublicId()
                  } else if (step.num === 2 && isAuthenticated) {
                    setWizardStep('mode-select')
                    setOutputToken(null)
                    setTokenError(null)
                  }
                }}
                disabled={!canClick || isLoading}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  isCurrent
                    ? 'bg-primary text-primary-foreground'
                    : isCompleted
                      ? 'bg-primary/20 text-primary hover:bg-primary/30 cursor-pointer'
                      : 'bg-muted text-muted-foreground'
                } ${canClick && !isCurrent ? 'cursor-pointer' : ''} ${isLoading ? 'opacity-50' : ''}`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                    isCurrent
                      ? 'bg-primary-foreground text-primary'
                      : isCompleted
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted-foreground/20'
                  }`}
                >
                  {isCompleted ? <Check className="h-3 w-3" /> : step.num}
                </span>
                <span className="hidden sm:inline">{step.label}</span>
              </button>
              {index < steps.length - 1 && (
                <ArrowRight className="h-4 w-4 mx-1 text-muted-foreground" />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // Render contact card section (used in create-token and view-card steps)
  const renderContactCard = () => {
    if (!contactCard || !fingerprint) return null

    return (
      <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20 space-y-4">
        {/* QR Code */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <QrCode className="h-5 w-5 text-primary" />
            <span className="text-sm font-semibold text-primary">Your Contact Card</span>
          </div>
          <div className="flex flex-col items-center gap-4">
            <div className="bg-white p-4 rounded-lg">
              <QRCodeSVG value={contactCard} size={200} level="M" />
            </div>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              Let contacts scan this QR code, or copy the card below to share via other means.
            </p>
          </div>
        </div>

        {/* Copy Contact Card */}
        <div className="pt-4 border-t">
          <div className="flex items-center gap-2 mb-2">
            <Key className="h-5 w-5 text-primary" />
            <span className="text-sm font-semibold text-primary">Contact Card (JSON)</span>
          </div>
          <div className="flex gap-2">
            <textarea
              readOnly
              value={contactCard}
              onClick={(e) => e.currentTarget.select()}
              rows={2}
              className="flex-1 text-xs bg-primary/10 border border-primary/20 p-2 rounded font-mono text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyContactCard}
              className={`flex-shrink-0 ${copiedContactCard ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-primary/10'}`}
            >
              {copiedContactCard ? (
                <Check className="h-4 w-4 text-white" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Contains your public ID and credential key. Share this with contacts.
          </p>
        </div>

        {/* Fingerprint */}
        <div className="pt-4 border-t">
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

  // Step 1: Authenticate
  const renderAuthenticateStep = () => (
    <div className="space-y-6">
      {/* Create passkey section - Primary action */}
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

      {/* Get My Public ID section - Secondary action */}
      <div className="space-y-3 p-4 rounded-lg border">
        <h3 className="font-medium flex items-center gap-2">
          <Key className="h-4 w-4" />
          Already Have a Passkey?
        </h3>
        <p className="text-sm text-muted-foreground">Authenticate to continue.</p>
        <Button onClick={handleGetPublicId} disabled={isLoading} className="w-full">
          {pageState === 'getting_key' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Authenticating...
            </>
          ) : (
            <>
              <Fingerprint className="mr-2 h-4 w-4" />
              Authenticate
            </>
          )}
        </Button>
      </div>
    </div>
  )

  // Step 2: Mode Select
  const renderModeSelectStep = () => (
    <div className="space-y-4">
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold">Choose your role</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Create a mutual token to securely identify your contacts
        </p>
      </div>

      <div className="grid gap-4">
        <Button
          onClick={() => setWizardStep('create-token')}
          className="h-auto py-4 flex flex-col items-start gap-1"
          variant="outline"
        >
          <div className="flex items-center gap-2 font-semibold">
            <Plus className="h-5 w-5" />
            I&apos;m starting the exchange
          </div>
          <p className="text-xs text-muted-foreground font-normal text-left">
            Share your contact card and create a pending token for your contact to complete
          </p>
        </Button>

        <Button
          onClick={() => setWizardStep('complete-token')}
          className="h-auto py-4 flex flex-col items-start gap-1"
          variant="outline"
        >
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-5 w-5" />
            I&apos;m completing an exchange
          </div>
          <p className="text-xs text-muted-foreground font-normal text-left">
            Share your contact card, then complete the pending token you receive
          </p>
        </Button>
      </div>
    </div>
  )

  // Step 3A: Create Token (with contact card at top)
  const renderCreateTokenStep = () => (
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
        Back to options
      </Button>

      {/* Contact card at top */}
      {renderContactCard()}

      {/* Token creation form */}
      <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10">
        <h3 className="font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-600" />
          Create Pending Token
        </h3>
        <p className="text-sm text-muted-foreground">
          After sharing your card above, paste your contact&apos;s card to create a pending token.
        </p>

        <div className="space-y-2">
          <Label htmlFor="contact-card">Contact&apos;s Card</Label>
          <Textarea
            id="contact-card"
            placeholder={`Paste contact's card (JSON with "id" and "cpk")...`}
            value={contactInput}
            onChange={(e) => setContactInput(e.target.value)}
            disabled={isLoading}
            className="font-mono text-xs min-h-[60px] resize-none"
          />
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
              Authenticating...
            </>
          ) : (
            <>
              <Shield className="mr-2 h-4 w-4" />
              Create Pending Token
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
              <span className="text-sm font-medium text-green-600">Pending Token Created</span>
            </div>
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
              Send this pending token to your contact. They will complete it and send back the final
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

  // Step 3B: Complete Token (with contact card at top)
  const renderCompleteTokenStep = () => (
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
        Back to options
      </Button>

      {/* Contact card at top */}
      {renderContactCard()}

      <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10">
        <h3 className="font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-600" />
          Complete Pending Token
        </h3>
        <p className="text-sm text-muted-foreground">
          Paste the pending token your contact sent you to complete the mutual token.
        </p>

        <div className="space-y-2">
          <Label htmlFor="pending-token">Pending Token</Label>
          <Textarea
            id="pending-token"
            placeholder="Paste the pending token from your contact..."
            value={contactInput}
            onChange={(e) => setContactInput(e.target.value)}
            disabled={isLoading}
            className="font-mono text-xs min-h-[80px] resize-none"
          />
        </div>

        <Button
          onClick={handleCompleteToken}
          disabled={!contactInput.trim() || isLoading}
          className="w-full"
        >
          {pageState === 'binding_contact' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Authenticating...
            </>
          ) : (
            <>
              <Shield className="mr-2 h-4 w-4" />
              Complete Token
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

  // Render current step content
  const renderStepContent = () => {
    switch (wizardStep) {
      case 'authenticate':
        return renderAuthenticateStep()
      case 'mode-select':
        return renderModeSelectStep()
      case 'create-token':
        return renderCreateTokenStep()
      case 'complete-token':
        return renderCompleteTokenStep()
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
          {/* Step indicator */}
          {renderStepIndicator()}

          {/* Error alert */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success alert */}
          {success && wizardStep === 'authenticate' && (
            <Alert className="border-green-500/50 bg-green-50/50 dark:bg-green-950/20">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertTitle className="text-green-600">Success</AlertTitle>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          {/* Current step content */}
          {renderStepContent()}

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
              the same token, proving mutual consent. The initiator creates a pending token, and the
              counterparty completes it with their signature.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
