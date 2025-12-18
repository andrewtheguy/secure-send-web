import { useState, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Copy, Check, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MAX_QR_DATA_SIZE, qrDataToBase64 } from '@/lib/qr-signaling'

interface QRDisplayProps {
  data: string
  label?: string
  showCopyButton?: boolean
}

export function QRDisplay({ data, label, showCopyButton = true }: QRDisplayProps) {
  const [copied, setCopied] = useState(false)

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

  const dataSize = data.length
  const isOversize = dataSize > MAX_QR_DATA_SIZE

  return (
    <div className="flex flex-col items-center space-y-3">
      {label && (
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      )}

      <div className="p-4 bg-white rounded-lg">
        <QRCodeSVG
          value={data}
          size={256}
          level={isOversize ? 'L' : 'M'}
          includeMargin
        />
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
