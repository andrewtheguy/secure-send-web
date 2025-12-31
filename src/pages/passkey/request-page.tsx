import { useNavigate } from 'react-router-dom'
import { Shield, Loader2, Camera, ArrowLeft, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { usePasskey } from '@/contexts/passkey-context'
import { parseInviteCode, uint8ArrayToBase64 } from '@/lib/passkey-utils'
import { PairingOutput } from '@/components/passkey'
import { createPairingRequest, INVITE_CODE_TTL_SECONDS } from '@/lib/crypto/pairing-key'
import { getPasskeyIdentity } from '@/lib/crypto/passkey'

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

      // parseInviteCode validates: JSON structure, non-empty id/ppk strings,
      // valid base64 encoding, 32-byte lengths, finite positive iat, and
      // iat not too far in the future (max 5 min clock skew)
      const inviteCodeParsed = parseInviteCode(trimmed)
      if (!inviteCodeParsed) {
        throw new Error(
          'Invalid invite code. Expected JSON with valid "id" (32 bytes), "ppk" (32 bytes), and "iat" (timestamp) fields.'
        )
      }

      // Check if invite code has expired (parseInviteCode doesn't check TTL expiration)
      const now = Math.floor(Date.now() / 1000)
      if (now - inviteCodeParsed.iat > INVITE_CODE_TTL_SECONDS) {
        throw new Error(
          'Invite code has expired (valid for 24 hours). Ask your peer to generate a new one.'
        )
      }

      // Authenticate fresh to get HMAC key
      const identity = await getPasskeyIdentity()

      const pairingRequest = await createPairingRequest({
        hmacKey: identity.hmacKey,
        peerPublicKey: identity.peerPublicKey,
        publicId: uint8ArrayToBase64(identity.publicIdBytes),
        inviteId: inviteCodeParsed.id,
        invitePpk: inviteCodeParsed.ppk,
        inviteIat: inviteCodeParsed.iat,
        comment: pairingComment.trim() || undefined,
      })

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
