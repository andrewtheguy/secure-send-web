import { useNavigate } from 'react-router-dom'
import { Shield, Loader2, Camera, ArrowLeft, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { usePasskey } from '@/contexts/passkey-context'
import {
  parseInviteCode,
  base64ToUint8Array,
  uint8ArrayToBase64,
} from '@/lib/passkey-utils'
import { PairingOutput } from '@/components/passkey'
import {
  createPairingRequest,
  INVITE_CODE_TTL_SECONDS,
  MAX_ACCEPTABLE_CLOCK_SKEW_SECONDS,
} from '@/lib/crypto/pairing-key'
import { getPasskeyIdentity } from '@/lib/crypto/passkey'
import { ValidationError } from '@/lib/errors'

export function PasskeyRequestPage() {
  const navigate = useNavigate()
  const {
    pageState,
    peerInput,
    pairingComment,
    pairingError,
    outputPairingKey,
    setPageState,
    setPeerInput,
    setPairingComment,
    setPairingError,
    setOutputPairingKey,
    openQRScanner,
    resetAll,
  } = usePasskey()

  const isLoading = pageState !== 'idle'

  const handleCreatePairingRequest = async () => {
    setPairingError(null)
    setOutputPairingKey(null)
    setPageState('pairing_peer')

    try {
      const trimmed = peerInput.trim()
      if (!trimmed) {
        throw new Error("Please enter peer's invite code")
      }

      const inviteCodeParsed = parseInviteCode(trimmed)
      if (!inviteCodeParsed) {
        throw new Error(
          'Invalid invite code format. Expected JSON with "id", "ppk", and "iat" (finite number) fields.'
        )
      }

      // Validate invite code fields
      try {
        const idBytes = base64ToUint8Array(inviteCodeParsed.id)
        if (idBytes.length !== 32) {
          throw new ValidationError('Invalid peer public ID: expected 32 bytes')
        }
        const ppkBytes = base64ToUint8Array(inviteCodeParsed.ppk)
        if (ppkBytes.length !== 32) {
          throw new ValidationError('Invalid peer public key: expected 32 bytes')
        }
      } catch (e) {
        if (e instanceof ValidationError) {
          throw e
        }
        throw new ValidationError('Invalid base64 encoding in invite code')
      }

      // Validate invite code TTL
      const now = Math.floor(Date.now() / 1000)
      if (inviteCodeParsed.iat > now + MAX_ACCEPTABLE_CLOCK_SKEW_SECONDS) {
        throw new Error('Invite code iat is in the future. Check your device clock.')
      }
      if (now - inviteCodeParsed.iat > INVITE_CODE_TTL_SECONDS) {
        throw new Error(
          'Invite code has expired (valid for 24 hours). Ask your peer to generate a new one.'
        )
      }

      // Authenticate fresh to get HMAC key
      const identity = await getPasskeyIdentity()

      const pairingRequest = await createPairingRequest(
        identity.hmacKey,
        identity.peerPublicKey,
        uint8ArrayToBase64(identity.publicIdBytes),
        inviteCodeParsed.id,
        inviteCodeParsed.ppk,
        inviteCodeParsed.iat,
        pairingComment.trim() || undefined
      )

      setOutputPairingKey(pairingRequest)
      setPeerInput('')
      setPairingComment('')
      setPageState('idle')
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : 'Failed to create pairing request')
      setPageState('idle')
    }
  }

  const handleStartOver = () => {
    resetAll()
    navigate('/passkey/pair')
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

      {/* Pairing request creation form */}
      <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/10">
        <h3 className="font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-600" />
          Create Pairing Request
        </h3>
        <p className="text-sm text-muted-foreground">
          Paste your peer&apos;s invite code to create a pairing request for them to confirm.
        </p>

        <div className="space-y-2">
          <Label htmlFor="invite-code">Peer&apos;s Invite Code</Label>
          <div className="flex gap-2">
            <Textarea
              id="invite-code"
              placeholder={`Paste peer's invite code (JSON with "id", "ppk", and "iat")...`}
              value={peerInput}
              onChange={(e) => setPeerInput(e.target.value)}
              disabled={isLoading}
              className="font-mono text-xs min-h-[60px] resize-none flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => openQRScanner('invite-code')}
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

        {outputPairingKey && <PairingOutput type="request" onStartOver={handleStartOver} />}
      </div>
    </div>
  )
}
