import { useState, useCallback, useEffect } from 'react'
import { Copy, Check, Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { generateTextQRCode } from '@/lib/qr-utils'
import { chunkPayload, buildChunkUrl } from '@/lib/chunk-utils'

interface MultiQRDisplayProps {
  data: Uint8Array
  clipboardData?: string
  showCopyButton?: boolean
}

interface ChunkQR {
  url: string
  imageUrl: string | null
  index: number
  total: number
}

export function MultiQRDisplay({ data, clipboardData, showCopyButton = true }: MultiQRDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [chunkQRs, setChunkQRs] = useState<ChunkQR[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!data || data.length === 0) {
      setChunkQRs([])
      return
    }

    setIsGenerating(true)
    setError(null)

    const useHash = import.meta.env.VITE_USE_HASH === 'true'
    const baseUrl = window.location.origin

    const chunks = chunkPayload(data)
    const urls = chunks.map(chunk => buildChunkUrl(baseUrl, chunk, useHash))

    // Generate QR codes for each URL
    Promise.all(
      urls.map(async (url, i) => {
        const imageUrl = await generateTextQRCode(url, {
          width: 400,
          errorCorrectionLevel: 'M',
        })
        return {
          url,
          imageUrl,
          index: i,
          total: chunks.length,
        } satisfies ChunkQR
      })
    )
      .then(setChunkQRs)
      .catch((err) => {
        console.error('Failed to generate QR codes:', err)
        setError('Failed to generate QR codes')
      })
      .finally(() => setIsGenerating(false))

    return () => {
      // Cleanup blob URLs
      for (const qr of chunkQRs) {
        if (qr.imageUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(qr.imageUrl)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

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

  if (isGenerating) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Generating QR codes...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center text-destructive text-sm py-8">
        <AlertCircle className="h-4 w-4 mr-2" />
        {error}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center space-y-4">
      <div className="text-xs text-muted-foreground">
        {data.length.toLocaleString()} bytes &bull; {chunkQRs.length} QR code{chunkQRs.length !== 1 ? 's' : ''}
      </div>

      <div className={`grid gap-4 ${chunkQRs.length === 1 ? 'grid-cols-1' : 'grid-cols-2'} w-full max-w-[600px]`}>
        {chunkQRs.map((qr) => (
          <div key={qr.index} className="flex flex-col items-center gap-1">
            <div className="p-2 bg-white rounded-lg flex items-center justify-center">
              {qr.imageUrl ? (
                <img
                  src={qr.imageUrl}
                  alt={`QR Code ${qr.index + 1} of ${qr.total}`}
                  className="block w-full h-auto"
                />
              ) : null}
            </div>
            {qr.total > 1 && (
              <p className="text-xs text-muted-foreground font-medium">
                {qr.index + 1} of {qr.total}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground font-mono break-all max-w-[280px]">
              {qr.url}
            </p>
          </div>
        ))}
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
