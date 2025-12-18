import { useState, useCallback, useEffect } from 'react'
import { Copy, Check, AlertCircle, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { generateQRCode } from '@/lib/qr-utils'

interface QRDisplayProps {
  data: string[]  // Array of QR chunks (may be single element)
  label?: string
  showCopyButton?: boolean
  clipboardData?: string  // Raw JSON for copy button (if different from QR data)
}

export function QRDisplay({ data, label, showCopyButton = true, clipboardData }: QRDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalQRs = data.length
  const currentData = data[currentIndex] || ''

  // Reset index when data changes
  useEffect(() => {
    setCurrentIndex(0)
  }, [data])

  // Generate QR code when current data changes
  useEffect(() => {
    if (!currentData) {
      setQrImageUrl(null)
      return
    }

    setIsGenerating(true)
    setError(null)

    generateQRCode(currentData, {
      width: 256,
      errorCorrectionLevel: 'M'
    })
      .then(setQrImageUrl)
      .catch((err) => {
        console.error('Failed to generate QR code:', err)
        setError('Failed to generate QR code')
        setQrImageUrl(null)
      })
      .finally(() => setIsGenerating(false))
  }, [currentData])

  // Copy clipboard data (raw JSON) or QR data
  const handleCopy = useCallback(async () => {
    try {
      const textToCopy = clipboardData || data.join('\n')
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [clipboardData, data])

  const handlePrev = useCallback(() => {
    setCurrentIndex(i => Math.max(0, i - 1))
  }, [])

  const handleNext = useCallback(() => {
    setCurrentIndex(i => Math.min(totalQRs - 1, i + 1))
  }, [totalQRs])

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
            alt={`QR Code ${currentIndex + 1} of ${totalQRs}`}
            width={256}
            height={256}
            className="block"
          />
        ) : null}
      </div>

      {/* Navigation for multiple QRs */}
      {totalQRs > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handlePrev}
            disabled={currentIndex === 0}
            className="h-8 w-8"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[80px] text-center">
            QR {currentIndex + 1} of {totalQRs}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNext}
            disabled={currentIndex === totalQRs - 1}
            className="h-8 w-8"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{currentData.length.toLocaleString()} chars</span>
        {totalQRs > 1 && (
          <span className="text-amber-600">
            ({totalQRs} QR codes)
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
              Copy Data
            </>
          )}
        </Button>
      )}
    </div>
  )
}
