import { useState, useCallback, useEffect, useRef } from 'react'
import { Copy, Check, Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { generateTextQRCode } from '@/lib/qr-utils'
import { chunkPayload, buildChunkUrl } from '@/lib/chunk-utils'
import { generateMutualClipboardData } from '@/lib/manual-signaling'

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

function revokeChunkQRImageUrls(chunks: ChunkQR[]) {
  for (const chunk of chunks) {
    if (chunk.imageUrl) {
      URL.revokeObjectURL(chunk.imageUrl)
    }
  }
}

export function MultiQRDisplay({ data, clipboardData, showCopyButton = true }: MultiQRDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [chunkQRs, setChunkQRs] = useState<ChunkQR[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chunkQRsRef = useRef<ChunkQR[]>([])

  useEffect(() => {
    chunkQRsRef.current = chunkQRs
  }, [chunkQRs])

  useEffect(() => {
    return () => {
      revokeChunkQRImageUrls(chunkQRsRef.current)
    }
  }, [])

  useEffect(() => {
    let active = true
    let generatedChunkQRs: ChunkQR[] = []

    if (!data || data.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: clear stale QR state when input is empty
      setChunkQRs((existingChunkQRs) => {
        revokeChunkQRImageUrls(existingChunkQRs)
        return []
      })
      setError(null)
      setIsGenerating(false)
      return () => {
        active = false
      }
    }

    setIsGenerating(true)
    setError(null)
    setChunkQRs((existingChunkQRs) => {
      revokeChunkQRImageUrls(existingChunkQRs)
      return []
    })

    const useHash = import.meta.env.VITE_USE_HASH === 'true'
    const baseUrl = window.location.origin

    const chunks = chunkPayload(data)
    const urls = chunks.map(chunk => buildChunkUrl(baseUrl, chunk, useHash))

    // Generate QR codes for each URL
    Promise.allSettled(
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
      .then((results) => {
        const fulfilledChunkQRs: ChunkQR[] = []
        let firstError: unknown = null

        for (const result of results) {
          if (result.status === 'fulfilled') {
            fulfilledChunkQRs.push(result.value)
          } else if (firstError === null) {
            firstError = result.reason
          }
        }

        generatedChunkQRs = fulfilledChunkQRs
        if (!active) {
          revokeChunkQRImageUrls(fulfilledChunkQRs)
          return
        }

        if (firstError !== null) {
          revokeChunkQRImageUrls(fulfilledChunkQRs)
          setChunkQRs([])
          console.error('Failed to generate QR codes:', firstError)
          setError('Failed to generate QR codes')
          return
        }

        setChunkQRs(fulfilledChunkQRs)
      })
      .catch((err) => {
        revokeChunkQRImageUrls(generatedChunkQRs)
        if (!active) {
          return
        }

        setChunkQRs([])
        console.error('Failed to generate QR codes:', err)
        setError('Failed to generate QR codes')
      })
      .finally(() => {
        if (active) {
          setIsGenerating(false)
        }
      })

    return () => {
      active = false
    }
  }, [data])

  const handleCopy = useCallback(async () => {
    if (!clipboardData && (!data || data.length === 0)) return
    try {
      const copyPayload = clipboardData ?? generateMutualClipboardData(data)
      await navigator.clipboard.writeText(copyPayload)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [clipboardData, data])

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

      <div className={`grid gap-4 ${chunkQRs.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'} w-full max-w-[600px]`}>
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
          </div>
        ))}
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
