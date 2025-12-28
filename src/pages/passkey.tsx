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
  getPasskeyECDHKeypair,
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
  const [publicKeyBase64, setPublicKeyBase64] = useState<string | null>(null)
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
    setPublicKeyBase64(null)
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

      // Immediately authenticate with the new credential to get the public key (skips picker)
      setPageState('getting_key')
      const keypair = await getPasskeyECDHKeypair(credentialId)
      setFingerprint(keypair.publicKeyFingerprint)
      setPublicKeyBase64(uint8ArrayToBase64(keypair.publicKeyBytes))
      setPrfSupported(keypair.prfSupported)
      setSuccess('Passkey created! Your public key is now available for sharing.')
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create passkey')
      setPageState('idle')
    }
  }

  const handleGetPublicKey = async () => {
    setError(null)
    setSuccess(null)
    setPageState('getting_key')

    try {
      const result = await getPasskeyECDHKeypair()
      setFingerprint(result.publicKeyFingerprint)
      setPublicKeyBase64(uint8ArrayToBase64(result.publicKeyBytes))
      setPrfSupported(result.prfSupported)
      setSuccess('Public key retrieved! Share this with your contacts for secure file transfers.')
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get public key')
      setPageState('idle')
    }
  }

  const copyToClipboard = async (
    text: string,
    onSuccess: () => void,
    onError: () => void
  ) => {
    try {
      // Try modern clipboard API first (requires secure context)
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        onSuccess()
        return
      }

      // Fallback: use legacy execCommand method
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.top = '-9999px'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()

      const successful = document.execCommand('copy')
      document.body.removeChild(textarea)

      if (successful) {
        onSuccess()
      } else {
        onError()
      }
    } catch {
      onError()
    }
  }

  const handleCopyPublicKey = async () => {
    if (!publicKeyBase64) return
    await copyToClipboard(
      publicKeyBase64,
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
            Generate your public key for secure, PIN-free file transfers
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
              Create a passkey to generate your unique public key. Share it with contacts
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
                  {pageState === 'getting_key' && 'Getting public key...'}
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Passkey
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              You'll be prompted twice: once to create, then to retrieve your public key.
            </p>
          </div>

          {/* Get My Public Key section - Secondary action */}
          {!publicKeyBase64 && (
            <div className="space-y-3 p-4 rounded-lg border">
              <h3 className="font-medium flex items-center gap-2">
                <Key className="h-4 w-4" />
                Already Have a Passkey?
              </h3>
              <p className="text-sm text-muted-foreground">
                Authenticate to display your public key.
              </p>
              <Button
                onClick={handleGetPublicKey}
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
                    Authenticate &amp; Get Public Key
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
                  onClick={handleGetPublicKey}
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

          {/* Public Key display with QR */}
          {publicKeyBase64 && fingerprint && (
            <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20 space-y-4">
              {/* QR Code */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <QrCode className="h-5 w-5 text-primary" />
                  <span className="text-sm font-semibold text-primary">Your Public Key</span>
                </div>
                <div className="flex flex-col items-center gap-4">
                  <div className="bg-white p-4 rounded-lg">
                    <QRCodeSVG value={publicKeyBase64} size={200} level="M" />
                  </div>
                  <p className="text-xs text-muted-foreground text-center max-w-xs">
                    Let contacts scan this QR code, or copy the key below to share via other means.
                  </p>
                </div>
              </div>

              {/* Copy Public Key */}
              <div className="pt-4 border-t">
                <div className="flex items-center gap-2 mb-2">
                  <Key className="h-5 w-5 text-primary" />
                  <span className="text-sm font-semibold text-primary">Public Key (base64)</span>
                </div>
                <div className="flex gap-2">
                  <code className="flex-1 text-sm bg-primary/10 border border-primary/20 p-2 rounded font-mono break-all max-h-20 overflow-y-auto text-primary">
                    {publicKeyBase64}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyPublicKey}
                    className="flex-shrink-0"
                  >
                    {copiedKey ? (
                      <Check className="h-4 w-4 text-green-600" />
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
                    className="h-8"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use to verify identity when sharing your public key.
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
              derives a deterministic ECDH keypair via the WebAuthn PRF extension. The public key
              (65 bytes, P-256 curve) is shared with contacts. When transferring files, both parties
              compute a shared secret using ECDH, ensuring only the intended recipient can decrypt.
            </p>
            <p>
              <span className="font-medium text-foreground">Key exchange:</span> Share your
              public key once with each contact (via QR code or copy/paste). No syncing required—
              each person uses their own passkey on their own device.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
