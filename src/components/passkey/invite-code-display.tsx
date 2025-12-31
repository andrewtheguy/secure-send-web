import { useState } from 'react'
import { Fingerprint, Key, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QRCodeSVG } from 'qrcode.react'
import { formatFingerprint } from '@/lib/crypto/ecdh'
import { usePasskey } from '@/contexts/passkey-context'

interface InviteCodeDisplayProps {
  stepNumber?: number
}

export function InviteCodeDisplay({ stepNumber }: InviteCodeDisplayProps) {
  const { inviteCode, fingerprint, prfSupported, setError } = usePasskey()
  const [copiedInviteCode, setCopiedInviteCode] = useState(false)
  const [copiedFingerprint, setCopiedFingerprint] = useState(false)

  if (!inviteCode || !fingerprint) return null

  const formattedFingerprint = formatFingerprint(fingerprint)

  const copyToClipboard = async (text: string, onSuccess: () => void) => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        setError('Clipboard not available')
        return
      }
      await navigator.clipboard.writeText(text)
      onSuccess()
    } catch {
      setError('Failed to copy to clipboard')
    }
  }

  const handleCopyInviteCode = async () => {
    await copyToClipboard(inviteCode, () => {
      setCopiedInviteCode(true)
      setTimeout(() => setCopiedInviteCode(false), 2000)
    })
  }

  const handleCopyFingerprint = async () => {
    await copyToClipboard(formattedFingerprint, () => {
      setCopiedFingerprint(true)
      setTimeout(() => setCopiedFingerprint(false), 2000)
    })
  }

  return (
    <div className="p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20 space-y-4">
      <div className="flex items-center gap-2">
        {stepNumber && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan-600 text-white text-sm font-medium">
            {stepNumber}
          </span>
        )}
        <span className="font-semibold text-cyan-700 dark:text-cyan-400">Your Invite Code</span>
      </div>

      {/* QR Code */}
      <div className="flex flex-col items-center gap-4">
        <div className="bg-white p-4 rounded-lg">
          <QRCodeSVG value={inviteCode} size={200} level="M" />
        </div>
        <p className="text-xs text-muted-foreground text-center max-w-xs">
          Share this QR code with your peer so they can create a pairing request.
        </p>
      </div>

      {/* Copy Invite Code */}
      <div className="pt-4 border-t border-cyan-500/30">
        <div className="flex items-center gap-2 mb-2">
          <Key className="h-4 w-4 text-cyan-600" />
          <span className="text-sm font-medium text-cyan-600">Invite Code (JSON)</span>
        </div>
        <div className="flex gap-2">
          <textarea
            readOnly
            value={inviteCode}
            onClick={(e) => e.currentTarget.select()}
            rows={2}
            className="flex-1 text-xs bg-cyan-500/10 border border-cyan-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500/30 resize-none"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyInviteCode}
            className={`flex-shrink-0 ${copiedInviteCode ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-cyan-500/10'}`}
          >
            {copiedInviteCode ? (
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
            className={`h-8 ${copiedFingerprint ? 'bg-emerald-500 hover:bg-emerald-500' : 'hover:bg-cyan-500/10'}`}
          >
            {copiedFingerprint ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Use to verify identity when sharing your invite code.
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
