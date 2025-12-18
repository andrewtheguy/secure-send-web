import { useState, useCallback, useEffect } from 'react'
import { Copy, Check, AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { generateBinaryQRCode } from '@/lib/qr-utils'

interface QRDisplayProps {
  data: Uint8Array  // Binary data for QR code (gzipped JSON)
  label?: string
  showCopyButton?: boolean
  clipboardData?: string  // Raw JSON for copy button
}

export function QRDisplay({ data, label, showCopyButton = true, clipboardData }: QRDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Generate QR code when data changes
  useEffect(() => {
    if (!data || data.length === 0) {
      setQrImageUrl(null)
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

    // Cleanup blob URL on unmount or data change
    return () => {
      if (qrImageUrl && qrImageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(qrImageUrl)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Copy clipboard data (raw JSON)
  const handleCopy = useCallback(async () => {
    if (!clipboardData) return
    try {
      await navigator.clipboard.writeText(clipboardData)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [clipboardData])

  return (
    <div className="flex flex-col items-center space-y-3">
      {label && (
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      )}

      <div className="p-4 bg-white rounded-lg min-h-[288px] min-w-[288px] flex items-center justify-center">
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

      <div className="text-xs text-muted-foreground">
        {data.length.toLocaleString()} bytes (compressed)
      </div>

      {showCopyButton && clipboardData && (
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
