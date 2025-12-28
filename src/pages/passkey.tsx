import { useState } from 'react'
import { Fingerprint, Plus, AlertCircle, CheckCircle2, Loader2, Info, Copy, Check, Key, QrCode } from 'lucide-react'
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

type PageState = 'idle' | 'checking' | 'creating' | 'getting_key'

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
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

  // Format fingerprint for display: XXXX-XXXX-XXX
  const formattedFingerprint = fingerprint
    ? `${fingerprint.slice(0, 4)}-${fingerprint.slice(4, 8)}-${fingerprint.slice(8, 11)}`
    : null

  const handleCreatePasskey = async () => {
    setError(null)
    setSuccess(null)
    setFingerprint(null)
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
      const result = await createPasskeyCredential(userName || 'Secure Transfer User')
      setPrfSupported(result.prfSupported)
      setUserName('') // Clear display name input after successful creation
      setSuccess(
        'Passkey created successfully! Click "Authenticate & Get Public Key" above to retrieve your public key for sharing.'
      )
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
      setPrfSupported(true)
      setSuccess('Public key retrieved! Share this with your contacts for secure file transfers.')
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get public key')
      setPageState('idle')
    }
  }

  const handleCopyPublicKey = async () => {
    if (!publicKeyBase64) return

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(publicKeyBase64)
        setCopiedKey(true)
        setTimeout(() => setCopiedKey(false), 2000)
        return
      }

      // Fallback: use legacy execCommand method
      const textarea = document.createElement('textarea')
      textarea.value = publicKeyBase64
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.top = '-9999px'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()

      const successful = document.execCommand('copy')
      document.body.removeChild(textarea)

      if (successful) {
        setCopiedKey(true)
        setTimeout(() => setCopiedKey(false), 2000)
      } else {
        setError('Failed to copy to clipboard')
        setTimeout(() => setError(null), 3000)
      }
    } catch {
      setError('Failed to copy to clipboard')
      setTimeout(() => setError(null), 3000)
    }
  }

  const handleCopyFingerprint = async () => {
    if (!formattedFingerprint) return

    try {
      // Try modern clipboard API first (requires secure context)
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(formattedFingerprint)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        return
      }

      // Fallback: use legacy execCommand method
      const textarea = document.createElement('textarea')
      textarea.value = formattedFingerprint
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.top = '-9999px'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()

      const successful = document.execCommand('copy')
      document.body.removeChild(textarea)

      if (successful) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } else {
        setError('Failed to copy to clipboard')
        setTimeout(() => setError(null), 3000)
      }
    } catch {
      setError('Failed to copy to clipboard')
      setTimeout(() => setError(null), 3000)
    }
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
            Create or test passkeys for passwordless file transfer encryption
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Info box */}
          <div className="rounded-lg bg-gradient-to-br from-primary/5 to-accent/5 border border-primary/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2">
                <Info className="h-4 w-4 text-primary" />
              </div>
              <div className="text-sm space-y-2">
                <p className="font-medium">Passkey-Based File Transfer</p>
                <p className="text-muted-foreground">
                  Use your passkey to derive a unique public key for secure file transfers.
                  Share your public key with contacts once—then send and receive files without
                  needing to share PINs. Each user has their own passkey; no syncing required.
                </p>
              </div>
            </div>
          </div>

          {/* Get My Public Key section */}
          <div className="space-y-4 p-4 rounded-lg border border-primary/20 bg-primary/5">
            <h3 className="font-medium flex items-center gap-2">
              <Key className="h-4 w-4" />
              Get My Public Key
            </h3>
            <p className="text-sm text-muted-foreground">
              Authenticate with your passkey to display your public key. Share this with
              contacts so they can send you files, and get their public key to send files to them.
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

          {/* Public Key display with QR */}
          {publicKeyBase64 && fingerprint && (
            <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20 space-y-4">
              {/* Fingerprint */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Fingerprint className="h-5 w-5 text-cyan-600" />
                    <span className="text-sm font-medium">Your Public Key Fingerprint</span>
                  </div>
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
                <div className="mt-2 font-mono text-xl text-cyan-600 tracking-wider">
                  {formattedFingerprint}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Others will see this fingerprint when you share your public key. Use it to verify identity.
                </p>
              </div>

              {/* QR Code */}
              <div className="pt-4 border-t">
                <div className="flex items-center gap-2 mb-3">
                  <QrCode className="h-5 w-5 text-cyan-600" />
                  <span className="text-sm font-medium">Your Public Key</span>
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
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Public Key (base64)</span>
                </div>
                <div className="flex gap-2">
                  <code className="flex-1 text-xs bg-muted p-2 rounded font-mono break-all max-h-20 overflow-y-auto">
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

              {prfSupported === false && (
                <p className="text-xs text-amber-600">
                  Warning: This passkey does not support the PRF extension required for encryption.
                </p>
              )}
            </div>
          )}

          {/* Create passkey section */}
          <div className="space-y-4 p-4 rounded-lg border">
            <h3 className="font-medium flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Register New Passkey
            </h3>
            <p className="text-sm text-muted-foreground">
              Create a new passkey for this app. The passkey will be stored in your
              browser or password manager and can be synced across devices.
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
                This name helps identify the passkey in your password manager.
              </p>
            </div>
            <Button
              onClick={handleCreatePasskey}
              disabled={isLoading}
              className="w-full"
            >
              {pageState === 'creating' || pageState === 'checking' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {pageState === 'checking' ? 'Checking support...' : 'Creating passkey...'}
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Passkey
                </>
              )}
            </Button>
          </div>

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
