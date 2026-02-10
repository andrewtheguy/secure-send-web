import { useState, useCallback, useRef, useEffect } from 'react'
import { RefreshCw, AlertCircle, Loader2, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useQRScanner } from '@/hooks/useQRScanner'
import { isValidBinaryPayload } from '@/lib/manual-signaling'
import { extractChunkParam, parseChunk, reassembleChunks } from '@/lib/chunk-utils'
import { isMobileDevice } from '@/lib/utils'

interface QRScannerProps {
  onScan: (binary: Uint8Array) => void
  expectedType: 'offer' | 'answer'
  onError?: (error: string) => void
  disabled?: boolean
}

export function QRScanner({ onScan, expectedType, onError, disabled }: QRScannerProps) {
  const [error, setError] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    isMobileDevice() ? 'environment' : 'user'
  )
  const [collectedCount, setCollectedCount] = useState(0)
  const [totalChunks, setTotalChunks] = useState<number | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const chunksRef = useRef<Map<number, Uint8Array>>(new Map())
  const totalChunksRef = useRef<number | null>(null)

  const showWarning = useCallback((msg: string) => {
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
    setWarning(msg)
    warningTimerRef.current = setTimeout(() => setWarning(null), 3000)
  }, [])

  // Clear warning timer on unmount
  useEffect(() => {
    return () => {
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
    }
  }, [])

  const clearChunkRefs = useCallback(() => {
    chunksRef.current.clear()
    totalChunksRef.current = null
  }, [])

  // Clear chunk state on unmount
  useEffect(() => {
    return clearChunkRefs
  }, [clearChunkRefs])

  // Clear chunk state when disabled
  useEffect(() => {
    if (disabled) {
      clearChunkRefs()
    }
  }, [disabled, clearChunkRefs])

  const handleScan = useCallback((binaryData: Uint8Array) => {
    if (expectedType === 'offer') {
      // URL-based QR codes from MultiQRDisplay
      const text = new TextDecoder().decode(binaryData)
      const param = extractChunkParam(text)
      if (!param) {
        console.debug('QRScanner: no chunk param found in QR text', text)
        showWarning('Unrecognized QR code, keep scanning...')
        return
      }

      const chunk = parseChunk(param)
      if (!chunk) {
        console.debug('QRScanner: failed to parse chunk param', param)
        setError('Could not parse QR code data')
        onError?.('Could not parse QR code data')
        return
      }

      // Reset if total changed (different transfer)
      if (totalChunksRef.current !== null && totalChunksRef.current !== chunk.total) {
        chunksRef.current.clear()
      }

      totalChunksRef.current = chunk.total
      chunksRef.current.set(chunk.index, chunk.data)
      setTotalChunks(chunk.total)
      setCollectedCount(chunksRef.current.size)
      setError(null)
      setWarning(null)

      if (chunksRef.current.size === chunk.total) {
        const assembled = reassembleChunks(chunksRef.current, chunk.total)
        clearChunkRefs()
        setCollectedCount(0)
        setTotalChunks(null)
        if (assembled) {
          onScan(assembled)
        } else {
          console.error('QRScanner: reassembleChunks failed for', chunk.total, 'chunks')
          const msg = 'Failed to reassemble QR data. Please try scanning again.'
          setError(msg)
          onError?.(msg)
        }
      }
    } else {
      // Binary SS03 payload from QRDisplay
      if (!isValidBinaryPayload(binaryData)) {
        setError('Invalid or unsupported QR payload format')
        onError?.('Invalid or unsupported QR payload format')
        return
      }

      setError(null)
      onScan(binaryData)
    }
  }, [onScan, onError, expectedType, clearChunkRefs, showWarning])

  const handleError = useCallback((err: string) => {
    setError(err)
    onError?.(err)
  }, [onError])

  const handleCameraReady = useCallback(() => {
    setCameraReady(true)
    setError(null)
  }, [])

  const { videoRef, canvasRef, availableCameras } = useQRScanner({
    onScan: handleScan,
    onError: handleError,
    onCameraReady: handleCameraReady,
    isScanning: !disabled,
    facingMode,
  })

  const handleSwitchCamera = useCallback(() => {
    setFacingMode((prev) => prev === 'environment' ? 'user' : 'environment')
  }, [])

  const needsMoreChunks = !disabled && totalChunks !== null && totalChunks > 1 && collectedCount < totalChunks

  return (
    <div className="space-y-3">
      <div className="relative bg-black rounded-lg overflow-hidden aspect-square max-w-[300px] mx-auto">
        {!cameraReady && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-2">Starting camera...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted p-4">
            <div className="text-center">
              <Camera className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-destructive flex items-center justify-center">
                <AlertCircle className="h-4 w-4 mr-1" />
                {error}
              </p>
            </div>
          </div>
        )}

        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />

        <canvas ref={canvasRef} className="hidden" />

        {/* Auto-dismissing warning banner */}
        {warning && !error && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1.5 pointer-events-none">
            <p className="text-xs text-yellow-300 text-center">{warning}</p>
          </div>
        )}

        {/* Scanning overlay */}
        {cameraReady && !error && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-[15%] border-2 border-white/50 rounded-lg" />
          </div>
        )}
      </div>

      {error && error.includes('denied') && (
        <p className="text-xs text-muted-foreground text-center">
          Please allow camera access in your browser settings and reload the page.
        </p>
      )}

      {/* Multi-chunk progress */}
      {needsMoreChunks && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground text-center">
            Collected {collectedCount} of {totalChunks} QR codes
          </p>
          <Progress value={(collectedCount / totalChunks) * 100} className="h-1.5" />
        </div>
      )}

      {availableCameras.length > 1 && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSwitchCamera}
            disabled={disabled || !cameraReady}
            className="text-xs"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Switch Camera
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center">
        Point your camera at the {expectedType} QR code{needsMoreChunks ? 's' : ''}
      </p>
    </div>
  )
}
