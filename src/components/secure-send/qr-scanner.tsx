import { useState, useCallback } from 'react'
import { RefreshCw, AlertCircle, Loader2, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useQRScanner } from '@/hooks/useQRScanner'
import { parseQRPayload, isValidQRPayload, type QRSignalingPayload } from '@/lib/qr-signaling'
import { isMobileDevice } from '@/lib/utils'

interface QRScannerProps {
  onScan: (payload: QRSignalingPayload) => void
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

  const handleScan = useCallback((data: Uint8Array) => {
    // Convert bytes to Latin-1 string
    let latin1String = ''
    for (let i = 0; i < data.length; i++) {
      latin1String += String.fromCharCode(data[i])
    }

    const payload = parseQRPayload(latin1String)
    if (!payload) {
      setError('Invalid QR code data')
      onError?.('Invalid QR code data')
      return
    }

    if (!isValidQRPayload(payload)) {
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
  }, [expectedType, onScan, onError])

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
      </p>
    </div>
  )
}
