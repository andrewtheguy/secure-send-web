import { useState, useCallback, useEffect } from 'react'
import { Copy, Check, AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MAX_QR_DATA_SIZE, qrDataToBase64 } from '@/lib/qr-signaling'
import { generateQRCode } from '@/lib/qr-utils'

interface QRDisplayProps {
  data: string
  label?: string
  showCopyButton?: boolean
}

export function QRDisplay({ data, label, showCopyButton = true }: QRDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dataSize = data.length
  const isOversize = dataSize > MAX_QR_DATA_SIZE

  // Generate QR code when data changes
  useEffect(() => {
    if (!data) {
      setQrImageUrl(null)
      return
    }

    setIsGenerating(true)
    setError(null)

    generateQRCode(data, {
      width: 256,
      errorCorrectionLevel: isOversize ? 'L' : 'M'
    })
      .then(setQrImageUrl)
      .catch((err) => {
        console.error('Failed to generate QR code:', err)
        setError('Failed to generate QR code')
        setQrImageUrl(null)
      })
      .finally(() => setIsGenerating(false))
  }, [data, isOversize])

  // Convert to base64 for clipboard (Latin-1 has non-printable chars)
  const handleCopy = useCallback(async () => {
    try {
      const base64Data = qrDataToBase64(data)
      await navigator.clipboard.writeText(base64Data)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [data])

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

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{dataSize.toLocaleString()} bytes</span>
        {isOversize && (
          <span className="flex items-center text-amber-600">
            <AlertCircle className="h-3 w-3 mr-1" />
            May be hard to scan
          </span>
        )}
      </div>

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
              Copy QR Data
            </>
          )}
        </Button>
      )}
    </div>
  )
}
