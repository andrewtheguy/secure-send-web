import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Fingerprint,
  AlertCircle,
  Loader2,
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { getPasskeyIdentity } from '@/lib/crypto/passkey'
import {
  verifyOwnSignature,
  isPairingKeyFormat,
  type VerifiedOwnSignature,
} from '@/lib/crypto/pairing-key'
import { formatFingerprint } from '@/lib/crypto/ecdh'

type PageState = 'idle' | 'verifying' | 'verified' | 'error'

export function PasskeyVerifyPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<PageState>('idle')
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [verificationResult, setVerificationResult] = useState<VerifiedOwnSignature | null>(null)

  const handleVerify = useCallback(async () => {
    const pairingKey = tokenInput.trim()
    if (!pairingKey) {
      setError('Please paste a pairing key')
      return
    }

    if (!isPairingKeyFormat(pairingKey)) {
      setError('Invalid format: expected a pairing key with both signatures')
      return
    }

    setState('verifying')
    setError(null)

    try {
      const identity = await getPasskeyIdentity()

      if (!identity.hmacKey) {
        throw new Error('Failed to derive HMAC signing key from passkey')
      }

      const result = await verifyOwnSignature(pairingKey, identity.hmacKey, identity.publicIdBytes)

      setVerificationResult(result)
      setState('verified')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Verification failed')
    }
  }, [tokenInput])

  const handleReset = useCallback(() => {
    setState('idle')
    setTokenInput('')
    setError(null)
    setVerificationResult(null)
  }, [])

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/passkey')}
        className="text-muted-foreground"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <div>
        <h3 className="font-semibold flex items-center gap-2 mb-2">
          <Fingerprint className="h-5 w-5" />
          Verify Pairing Key Signature
        </h3>
        <p className="text-sm text-muted-foreground">
          Verify that you signed a pairing key with your passkey
        </p>
      </div>

      {/* Info alert */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>How pairing key verification works</AlertTitle>
        <AlertDescription className="text-sm">
          With HMAC signatures, each party can only verify their own signature. This proves{' '}
          <strong>you</strong> signed the pairing key with your passkey. The peer&apos;s identity
          was established during identity card exchange via fingerprint verification.
        </AlertDescription>
      </Alert>

      {state === 'idle' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="token">Pairing Key</Label>
            <Textarea
              id="token"
              placeholder="Paste your pairing key here (JSON with both signatures)"
              value={tokenInput}
              onChange={(e) => {
                setTokenInput(e.target.value)
                setError(null)
              }}
              className="min-h-[120px] font-mono text-xs"
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button onClick={handleVerify} disabled={!tokenInput.trim()} className="w-full">
            <Fingerprint className="mr-2 h-4 w-4" />
            Verify with Passkey
          </Button>
        </div>
      )}

      {state === 'verifying' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Authenticating with passkey...</p>
        </div>
      )}

      {state === 'verified' && verificationResult && (
        <div className="space-y-4">
          <Alert className="border-green-500 bg-green-50 dark:bg-green-950/20">
            <ShieldCheck className="h-4 w-4 text-green-600" />
            <AlertTitle className="text-green-700 dark:text-green-400">
              Your signature verified
            </AlertTitle>
            <AlertDescription className="text-green-600 dark:text-green-300">
              This token was signed by your passkey. You are Party {verificationResult.myRole}.
            </AlertDescription>
          </Alert>

          <div className="rounded-lg border p-4 space-y-3">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Your Fingerprint
              </div>
              <div className="font-mono text-sm text-green-600 dark:text-green-400">
                {formatFingerprint(verificationResult.myFingerprint)}
              </div>
            </div>

            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Peer Fingerprint
              </div>
              <div className="font-mono text-sm">
                {formatFingerprint(verificationResult.peerFingerprint)}
              </div>
            </div>

            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Pairing Key Created
              </div>
              <div className="text-sm">{verificationResult.issuedAt.toLocaleString()}</div>
            </div>

            {verificationResult.comment && (
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Comment</div>
                <div className="text-sm">{verificationResult.comment}</div>
              </div>
            )}
          </div>

          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Peer verification</AlertTitle>
            <AlertDescription className="text-sm">
              The peer&apos;s signature cannot be verified without their passkey. Trust in their
              identity relies on the fingerprint verification you performed when exchanging identity
              cards.
            </AlertDescription>
          </Alert>

          <Button onClick={handleReset} variant="outline" className="w-full">
            Verify Another Pairing Key
          </Button>
        </div>
      )}

      {state === 'error' && (
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Verification Failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>

          <Button onClick={handleReset} variant="outline" className="w-full">
            Try Again
          </Button>
        </div>
      )}
    </div>
  )
}
