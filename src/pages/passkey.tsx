import { useState } from 'react'
import { Fingerprint, Plus, AlertCircle, CheckCircle2, Loader2, Copy, Check, Key, QrCode } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { QRCodeSVG } from 'qrcode.react'
import {
  checkWebAuthnSupport,
  createPasskeyCredential,
  getPasskeyIdentity,
} from '@/lib/crypto/passkey'
import { formatFingerprint } from '@/lib/crypto/ecdh'

type PageState = 'idle' | 'checking' | 'creating' | 'getting_key'

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''))
}

export function PasskeyPage() {
  const [pageState, setPageState] = useState<PageState>('idle')
  const [userName, setUserName] = useState('')
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [publicIdBase64, setPublicIdBase64] = useState<string | null>(null)
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)

  // Format fingerprint for display: XXXX-XXXX-XXXX-XXXX
  const formattedFingerprint = fingerprint ? formatFingerprint(fingerprint) : null

  const handleCreatePasskey = async () => {
    setError(null)
    setSuccess(null)
    setFingerprint(null)
    setPublicIdBase64(null)
    setPrfSupported(null)
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
      const { credentialId } = await createPasskeyCredential(userName || 'Secure Transfer User')
      setUserName('') // Clear display name input after successful creation

      // Immediately authenticate with the new credential to get the public ID (skips picker)
      setPageState('getting_key')
      const identity = await getPasskeyIdentity(credentialId)
      setFingerprint(identity.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(identity.publicIdBytes))
      setPrfSupported(identity.prfSupported)
      setSuccess('Passkey created! Your public ID is now available for sharing.')
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create passkey')
      setPageState('idle')
    }
  }

  const handleGetPublicId = async () => {
    setError(null)
    setSuccess(null)
    setPageState('getting_key')

    try {
      const result = await getPasskeyIdentity()
      setFingerprint(result.publicIdFingerprint)
      setPublicIdBase64(uint8ArrayToBase64(result.publicIdBytes))
      setPrfSupported(result.prfSupported)
      setSuccess('Public ID retrieved! Share this with your contacts for secure file transfers.')
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get public ID')
      setPageState('idle')
    }
  }

  const copyToClipboard = async (
    text: string,
    onSuccess: () => void,
    onError: () => void
  ) => {
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

  const handleCopyPublicId = async () => {
    if (!publicIdBase64) return
    await copyToClipboard(
      publicIdBase64,
      () => {
        setCopiedKey(true)
        setTimeout(() => setCopiedKey(false), 2000)
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

  const isLoading = pageState !== 'idle'

  return (
    <div className="flex w-full justify-center">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-2xl flex items-center gap-2">
            <Fingerprint className="h-6 w-6" />
            Passkey Setup
          </CardTitle>
          <CardDescription>
            Generate your passkey public ID for secure, PIN-free file transfers
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Create passkey section - Primary action */}
          <div className="space-y-4 p-4 rounded-lg border-2 border-primary/30 bg-primary/5">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Create New Passkey
            </h3>
            <p className="text-sm">
              Create a passkey to generate your unique public ID. Share it with contacts
              for secure file transfers without needing PINs.
            </p>
            <div className="space-y-2">
              <Label htmlFor="userName">Display Name (optional)</Label>
              <Input
                id="userName"
                placeholder="e.g., Work Laptop, Personal"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                disabled={isLoading}
              />
              <p className="text-xs text-muted-foreground">
                Helps identify this passkey in your password manager.
              </p>
            </div>
            <Button
              onClick={handleCreatePasskey}
              disabled={isLoading}
              className="w-full"
              size="lg"
            >
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
              Two prompts are expected: first to create the passkey, then to authenticate and derive your public ID.
            </p>
          </div>

          {/* Get My Public ID section - Secondary action */}
          {!publicIdBase64 && (
            <div className="space-y-3 p-4 rounded-lg border">
              <h3 className="font-medium flex items-center gap-2">
                <Key className="h-4 w-4" />
                Already Have a Passkey?
              </h3>
              <p className="text-sm text-muted-foreground">
                Authenticate to display your public ID.
              </p>
              <Button
                onClick={handleGetPublicId}
                disabled={isLoading}
                className="w-full"
              >
                {pageState === 'getting_key' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Authenticating...
                  </>
                ) : (
                    <>
                      <Fingerprint className="mr-2 h-4 w-4" />
                      Authenticate &amp; Get Public ID
                    </>
                  )}
              </Button>
            </div>
          )}

          {/* Error alert */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success alert with Authenticate Again option */}
          {success && (
            <Alert className="border-green-500/50 bg-green-50/50 dark:bg-green-950/20">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertTitle className="text-green-600">Success</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-4">
                <span>{success}</span>
                <Button
                  onClick={handleGetPublicId}
                  disabled={isLoading}
                  size="sm"
                >
                  {pageState === 'getting_key' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Fingerprint className="mr-2 h-4 w-4" />
                      Authenticate Again
                    </>
                  )}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Public ID display with QR */}
          {publicIdBase64 && fingerprint && (
            <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20 space-y-4">
              {/* QR Code */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <QrCode className="h-5 w-5 text-primary" />
                  <span className="text-sm font-semibold text-primary">Your Public ID</span>
                </div>
                <div className="flex flex-col items-center gap-4">
                  <div className="bg-white p-4 rounded-lg">
                    <QRCodeSVG value={publicIdBase64} size={200} level="M" />
                  </div>
                  <p className="text-xs text-muted-foreground text-center max-w-xs">
                    Let contacts scan this QR code, or copy the key below to share via other means.
                  </p>
                </div>
              </div>

              {/* Copy Public ID */}
              <div className="pt-4 border-t">
                <div className="flex items-center gap-2 mb-2">
                  <Key className="h-5 w-5 text-primary" />
                  <span className="text-sm font-semibold text-primary">Public ID (base64)</span>
                </div>
                <div className="flex gap-2">
                  <textarea
                    readOnly
                    value={publicIdBase64}
                    onClick={(e) => e.currentTarget.select()}
                    rows={2}
                    className="flex-1 text-sm bg-primary/10 border border-primary/20 p-2 rounded font-mono text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyPublicId}
                    className={`flex-shrink-0 ${copiedKey ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-primary/10'}`}
                  >
                    {copiedKey ? (
                      <Check className="h-4 w-4 text-white" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
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
                    {copied ? (
                      <Check className="h-4 w-4 text-white" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use to verify identity when sharing your public ID.
                </p>
              </div>

              {prfSupported === false && (
                <p className="text-xs text-amber-600">
                  Warning: This passkey does not support the PRF extension required for encryption.
                </p>
              )}
            </div>
          )}

          {/* Technical details */}
          <div className="text-xs text-muted-foreground space-y-1 border-t pt-4">
            <p>
              <span className="font-medium text-foreground">How it works:</span> Your passkey
              derives a non-extractable master key via the WebAuthn PRF extension. A shareable
              public ID and fingerprint are derived with HKDF. Transfers use ephemeral ECDH session
              keys plus passkey-bound session binding, ensuring only the intended recipient can decrypt.
            </p>
            <p>
              <span className="font-medium text-foreground">Key exchange:</span> Share your
              public ID once with each contact (via QR code or copy/paste). Each party uses their
              own passkey (synced across their devices).
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
