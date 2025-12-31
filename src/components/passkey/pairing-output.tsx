import { useState, useEffect } from 'react'
import { CheckCircle2, Copy, Check, Download, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { generateTextQRCode } from '@/lib/qr-utils'
import { downloadTextFile } from '@/lib/file-utils'
import { usePasskey } from '@/contexts/passkey-context'

interface PairingOutputProps {
  type: 'request' | 'key'
  stepNumber?: number
  onStartOver?: () => void
}

export function PairingOutput({ type, stepNumber, onStartOver }: PairingOutputProps) {
  const { outputPairingKey, setPairingError } = usePasskey()
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const isRequest = type === 'request'
  const label = isRequest ? 'Pairing Request' : 'Pairing Key'
  const labelColor = isRequest ? 'text-amber-600' : 'text-green-600'
  const labelBg = isRequest ? 'bg-amber-100' : 'bg-green-100'
  const filePrefix = isRequest ? 'pairing-request' : 'pairing-key'

  // Generate QR code
  useEffect(() => {
    let cancelled = false
    let currentUrl: string | null = null

    if (outputPairingKey) {
      generateTextQRCode(outputPairingKey, { width: 256, errorCorrectionLevel: 'L' })
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          currentUrl = url
          setQrUrl(url)
          setQrError(null)
        })
        .catch((err) => {
          if (cancelled) return
          console.error('Failed to generate QR code:', err)
          setQrUrl(null)
          setQrError(err instanceof Error ? err.message : 'Failed to generate QR code')
        })
    }
    // Note: no else branch needed since component returns null when !outputPairingKey

    return () => {
      cancelled = true
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl)
      }
    }
  }, [outputPairingKey])

  if (!outputPairingKey) return null

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        setPairingError('Clipboard not available')
        return
      }
      await navigator.clipboard.writeText(outputPairingKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setPairingError('Failed to copy to clipboard')
    }
  }

  const handleDownload = () => {
    try {
      downloadTextFile(outputPairingKey, `${filePrefix}-${Date.now()}.json`, 'application/json')
    } catch (err) {
      console.error('Failed to download file:', err)
      setPairingError('Failed to download file')
    }
  }

  return (
    <div className="space-y-3 pt-3 border-t border-amber-500/30">
      {stepNumber && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-600 text-white text-xs font-medium">
            {stepNumber}
          </span>
          <span className="font-medium">Share with Your Peer</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        <span className="text-sm font-medium text-green-600">
          {isRequest ? 'Pairing Request Created' : 'Pairing Key Completed'}
        </span>
      </div>

      {/* QR Code */}
      {qrUrl && (
        <div className="flex flex-col items-center gap-2">
          <div className="bg-white p-3 rounded-lg">
            <img src={qrUrl} alt={`${label} QR Code`} className="w-48 h-48" />
          </div>
          <span className={`text-xs font-medium ${labelColor} ${labelBg} px-2 py-0.5 rounded`}>
            {label}
          </span>
          <p className="text-xs text-muted-foreground">
            {isRequest ? 'Let your peer scan this QR code' : 'Share this QR code with your peer'}
          </p>
        </div>
      )}
      {qrError && (
        <div className="flex flex-col items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
          <p className="text-sm text-destructive">QR code generation failed: {qrError}</p>
          <p className="text-xs text-muted-foreground">Copy the text below instead</p>
        </div>
      )}

      {/* Text output with copy/download */}
      <div className="flex gap-2">
        <Textarea
          readOnly
          value={outputPairingKey}
          onClick={(e) => e.currentTarget.select()}
          rows={4}
          className="flex-1 text-xs bg-amber-500/10 border border-amber-500/20 p-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
        />
        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className={`flex-shrink-0 ${copied ? 'bg-emerald-500 border-emerald-500 hover:bg-emerald-500' : 'hover:bg-amber-500/10'}`}
          >
            {copied ? <Check className="h-4 w-4 text-white" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            className="flex-shrink-0 hover:bg-amber-500/10"
            aria-label={`Download ${label.toLowerCase()}`}
            title={`Download ${label.toLowerCase()}`}
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Alert className="bg-blue-50 border-blue-200">
        <Info className="h-4 w-4 text-blue-600" />
        <AlertDescription className="text-blue-800 text-xs">
          {isRequest
            ? 'This can be shared publicly — it contains no secrets, only public identifiers and your digital signature.'
            : 'This pairing key can be shared publicly — it contains no secrets, only public identifiers and digital signatures proving mutual consent. Both you and your peer need this same key for secure transfers.'}
        </AlertDescription>
      </Alert>

      <p className="text-xs text-muted-foreground">
        {isRequest
          ? 'Send this pairing request to your peer. They will confirm it and send back the final pairing key.'
          : null}
      </p>

      {onStartOver && (
        <Button variant="outline" onClick={onStartOver} className="w-full">
          Start Over
        </Button>
      )}
    </div>
  )
}
