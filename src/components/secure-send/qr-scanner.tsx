import { useState, useCallback } from 'react'
import { RefreshCw, AlertCircle, Loader2, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useQRScanner } from '@/hooks/useQRScanner'
import { parseQRChunk, parseQRPayload, mergeQRChunks, isValidSignalingPayload, type SignalingPayload } from '@/lib/qr-signaling'
import { isMobileDevice } from '@/lib/utils'

interface QRScannerProps {
  onScan: (payload: SignalingPayload) => void
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

  // Multi-QR chunk collection state
  const [collectedChunks, setCollectedChunks] = useState<Map<number, string>>(new Map())
  const [expectedTotal, setExpectedTotal] = useState<number | null>(null)

  const handleScan = useCallback((rawData: string) => {
    // Try to parse as QR chunk format (X/Y:data$)
    const chunk = parseQRChunk(rawData)

    if (chunk) {
      // Multi-QR: collect chunk
      setExpectedTotal(chunk.total)
      const newChunks = new Map(collectedChunks)
      newChunks.set(chunk.index, rawData)
      setCollectedChunks(newChunks)

      // Check if complete
      if (newChunks.size === chunk.total) {
        // Merge chunks → decode base45 → decompress → parse JSON
        const mergedBase45 = mergeQRChunks(Array.from(newChunks.values()))
        if (!mergedBase45) {
          setError('Failed to merge QR chunks')
          onError?.('Failed to merge QR chunks')
          return
        }

        const payload = parseQRPayload(mergedBase45)
        if (!payload) {
          setError('QR scanned but data format is invalid')
          onError?.('QR scanned but data format is invalid')
          return
        }

        if (!isValidSignalingPayload(payload)) {
          setError('Malformed QR payload')
          onError?.('Malformed QR payload')
          return
        }

        if (payload.type !== expectedType) {
          setError(`Expected ${expectedType} QR code, got ${payload.type}`)
          onError?.(`Expected ${expectedType} QR code, got ${payload.type}`)
          return
        }

        // Success - reset state and call onScan
        setError(null)
        setCollectedChunks(new Map())
        setExpectedTotal(null)
        onScan(payload)
      }
    } else {
      // Not a chunk format - try parsing directly as single QR (legacy support)
      // This handles the case where the QR might not have the X/Y:data$ format
      const payload = parseQRPayload(rawData)
      if (!payload) {
        setError('QR scanned but data format is invalid')
        onError?.('QR scanned but data format is invalid')
        return
      }

      if (!isValidSignalingPayload(payload)) {
        setError('Malformed QR payload')
        onError?.('Malformed QR payload')
        return
      }

      if (payload.type !== expectedType) {
        setError(`Expected ${expectedType} QR code, got ${payload.type}`)
        onError?.(`Expected ${expectedType} QR code, got ${payload.type}`)
        return
      }

      setError(null)
      onScan(payload)
    }
  }, [collectedChunks, expectedType, onScan, onError])

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
    preferLowRes: isMobileDevice(),
  })

  const handleSwitchCamera = useCallback(() => {
    setFacingMode((prev) => prev === 'environment' ? 'user' : 'environment')
  }, [])

  const handleReset = useCallback(() => {
    setCollectedChunks(new Map())
    setExpectedTotal(null)
    setError(null)
  }, [])

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

        {/* Scanning overlay */}
        {cameraReady && !error && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-[15%] border-2 border-white/50 rounded-lg" />
          </div>
        )}
      </div>

      {/* Multi-QR progress indicator */}
      {expectedTotal && expectedTotal > 1 && collectedChunks.size < expectedTotal && (
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            Scanned {collectedChunks.size} of {expectedTotal} QR codes
          </p>
          <div className="flex justify-center gap-1 mt-1">
            {Array.from({ length: expectedTotal }, (_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full ${
                  collectedChunks.has(i + 1) ? 'bg-green-500' : 'bg-muted-foreground/30'
                }`}
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="text-xs mt-2"
          >
            Reset
          </Button>
        </div>
      )}

      {error && error.includes('denied') && (
        <p className="text-xs text-muted-foreground text-center">
          Please allow camera access in your browser settings and reload the page.
        </p>
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
        Point your camera at the {expectedType} QR code
        {expectedTotal && expectedTotal > 1 && ' (scan all codes)'}
      </p>
    </div>
  )
}
