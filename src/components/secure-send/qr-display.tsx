import { useState, useCallback, useEffect } from 'react'
import { Copy, Check, AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { generateBinaryQRCode } from '@/lib/qr-utils'
import { generateMutualClipboardData } from '@/lib/manual-signaling'

interface QRDisplayProps {
  data: Uint8Array  // Binary data for QR code (gzipped JSON)
  label?: string
  showCopyButton?: boolean
  clipboardData?: string  // Raw JSON for copy button
  showSize?: boolean
}

export function QRDisplay({ data, label, showCopyButton = true, clipboardData, showSize = true }: QRDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Generate QR code when data changes
  useEffect(() => {
    if (!data || data.length === 0) {
      setQrImageUrl(null) // eslint-disable-line react-hooks/set-state-in-effect
      return
    }

    setIsGenerating(true)
    setError(null)

    generateBinaryQRCode(data, {
      width: 400,
      errorCorrectionLevel: 'M'
    })
      .then((url) => {
        setQrImageUrl(url)
      })
      .catch((err) => {
        console.error('Failed to generate QR code:', err)
        setError('Failed to generate QR code')
        setQrImageUrl(null)
      })
      .finally(() => setIsGenerating(false))
  }, [data])

  // Copy signaling payload as base64 for paste flow.
  const handleCopy = useCallback(async () => {
    if (!data || data.length === 0) return
    try {
      const copyPayload = (clipboardData && clipboardData.length > 0)
        ? clipboardData
        : generateMutualClipboardData(data)
      await navigator.clipboard.writeText(copyPayload)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [clipboardData, data])

  return (
    <div className="flex flex-col items-center space-y-3">
      {label && (
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      )}

      <div className="p-4 bg-white rounded-lg flex items-center justify-center">
        {isGenerating ? (
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        ) : error ? (
          <div className="text-destructive text-sm flex items-center">
            <AlertCircle className="h-4 w-4 mr-2" />
            {error}
          </div>
        ) : qrImageUrl ? (
          <img
            src={qrImageUrl}
            alt="QR Code"
            width={256}
            height={256}
            className="block"
          />
        ) : null}
      </div>

      {showSize && (
        <div className="text-xs text-muted-foreground">
          {data.length.toLocaleString()} bytes (compressed)
        </div>
      )}

      {showCopyButton && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          className="text-xs"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 mr-1 text-green-500" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 mr-1" />
              Copy Data
            </>
          )}
        </Button>
      )}
    </div>
  )
}
