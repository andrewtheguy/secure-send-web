import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shield, Loader2, Camera, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle } from 'lucide-react'
import { usePasskey } from '@/contexts/passkey-context'
import { uint8ArrayToBase64 } from '@/lib/passkey-utils'
import { PairingOutput } from '@/components/passkey'
import { isPairingRequestFormat, confirmPairingRequest } from '@/lib/crypto/pairing-key'
import { getPasskeyIdentity } from '@/lib/crypto/passkey'

export function PasskeyConfirmPage() {
  const navigate = useNavigate()
  const {
    fingerprint,
    pageState,
    peerInput,
    pairingError,
    outputPairingKey,
    setPageState,
    setPeerInput,
    setPairingError,
    setOutputPairingKey,
    openQRScanner,
    resetAll,
    authenticate,
  } = usePasskey()

  const isLoading = pageState !== 'idle'

  // Auto-authenticate if not already authenticated
  useEffect(() => {
    if (!fingerprint && pageState === 'idle') {
      authenticate().then((success) => {
        if (!success) {
          navigate('/passkey/pair')
        }
      })
    }
  }, [fingerprint, pageState, authenticate, navigate])

  const handleConfirmRequest = async () => {
    setPairingError(null)
    setOutputPairingKey(null)
    setPageState('pairing_peer')

    try {
      const trimmed = peerInput.trim()
      if (!trimmed) {
        throw new Error('Please enter pairing request')
      }

      if (!isPairingRequestFormat(trimmed)) {
        throw new Error('Invalid pairing request format')
      }

      // Authenticate fresh to get HMAC key
      const identity = await getPasskeyIdentity()

      const pairingKey = await confirmPairingRequest(
        trimmed,
        identity.hmacKey,
        identity.peerPublicKey,
        uint8ArrayToBase64(identity.publicIdBytes)
      )

      setOutputPairingKey(pairingKey)
      setPeerInput('')
      setPageState('idle')
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : 'Failed to confirm pairing request')
      setPageState('idle')
    }
  }

  const handleStartOver = () => {
    resetAll()
    navigate('/passkey/pair')
  }

  if (!fingerprint && isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">Authenticating...</p>
      </div>
    )
  }

  if (!fingerprint) {
    // Show fallback while useEffect triggers redirect to /passkey/pair
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-4">
        <p className="text-muted-foreground">Redirecting to pairing options...</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/passkey/pair')}>
          Go to Pairing Options
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
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

      {/* Confirm Pairing Request */}
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

        {outputPairingKey && <PairingOutput type="key" stepNumber={4} onStartOver={handleStartOver} />}
      </div>
    </div>
  )
}
