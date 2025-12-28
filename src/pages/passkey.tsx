import { useState } from 'react'
import { Fingerprint, Plus, TestTube, AlertCircle, CheckCircle2, Loader2, Info, Copy, Check } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  checkWebAuthnSupport,
  createPasskeyCredential,
  testPasskeyAndGetFingerprint,
} from '@/lib/crypto/passkey'

type PageState = 'idle' | 'checking' | 'creating' | 'testing'

export function PasskeyPage() {
  const [pageState, setPageState] = useState<PageState>('idle')
  const [userName, setUserName] = useState('')
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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
      setFingerprint(result.fingerprint)
      setPrfSupported(true)
      setSuccess('Passkey created successfully! It should now be available in your password manager.')
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create passkey')
      setPageState('idle')
    }
  }

  const handleTestPasskey = async () => {
    setError(null)
    setSuccess(null)
    setFingerprint(null)
    setPrfSupported(null)
    setPageState('testing')

    try {
      const result = await testPasskeyAndGetFingerprint()
      setFingerprint(result.fingerprint)
      setPrfSupported(result.prfSupported)
      setSuccess(
        result.prfSupported
          ? 'Passkey verified! PRF extension is supported.'
          : 'Passkey found but PRF extension is not supported. This passkey cannot be used for encryption.'
      )
      setPageState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to test passkey')
      setPageState('idle')
    }
  }

  const handleCopyFingerprint = async () => {
    if (formattedFingerprint) {
      await navigator.clipboard.writeText(formattedFingerprint)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
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
                <p className="font-medium">What are passkeys?</p>
                <p className="text-muted-foreground">
                  Passkeys are a modern, passwordless authentication method. When synced via
                  1Password, iCloud Keychain, or Google Password Manager, both sender and
                  receiver can use the same passkey to encrypt/decrypt files without sharing a PIN.
                </p>
              </div>
            </div>
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

          {/* Fingerprint display */}
          {fingerprint && (
            <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Fingerprint className="h-5 w-5 text-cyan-600" />
                  <span className="text-sm font-medium">Passkey Fingerprint</span>
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
                Share this fingerprint with recipients to verify you&apos;re using the same passkey.
              </p>
              {prfSupported === false && (
                <p className="mt-2 text-xs text-amber-600">
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

          {/* Test passkey section */}
          <div className="space-y-4 p-4 rounded-lg border">
            <h3 className="font-medium flex items-center gap-2">
              <TestTube className="h-4 w-4" />
              Test Existing Passkey
            </h3>
            <p className="text-sm text-muted-foreground">
              Verify your passkey works and view its fingerprint. Use this to confirm
              you and your recipient have the same synced passkey.
            </p>
            <Button
              onClick={handleTestPasskey}
              disabled={isLoading}
              variant="outline"
              className="w-full"
            >
              {pageState === 'testing' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing passkey...
                </>
              ) : (
                <>
                  <TestTube className="mr-2 h-4 w-4" />
                  Test Passkey
                </>
              )}
            </Button>
          </div>

          {/* Technical details */}
          <div className="text-xs text-muted-foreground space-y-1 border-t pt-4">
            <p>
              <span className="font-medium text-foreground">How it works:</span> Passkeys use
              the WebAuthn PRF extension to derive encryption keys. The fingerprint is a
              SHA-256 hash of the credential ID, displayed as an 11-character identifier.
            </p>
            <p>
              <span className="font-medium text-foreground">Sync requirements:</span> Both
              parties must have the passkey synced via the same password manager
              (1Password, iCloud Keychain, Google Password Manager, etc.).
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
