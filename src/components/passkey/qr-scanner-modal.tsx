import { Camera, X, AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePasskey } from '@/contexts/passkey-context'

export function QRScannerModal() {
  const {
    showQRScanner,
    qrScannerMode,
    qrScanError,
    videoRef,
    canvasRef,
    availableCameras,
    closeQRScanner,
    switchCamera,
  } = usePasskey()

  if (!showQRScanner) return null

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-scanner-title"
    >
      <div className="bg-background rounded-lg p-4 max-w-sm w-full mx-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 id="qr-scanner-title" className="font-medium flex items-center gap-2">
            <Camera className="h-5 w-5" />
            {qrScannerMode === 'invite-code' ? 'Scan Invite Code' : 'Scan Pairing Request'}
          </h3>
          <Button variant="ghost" size="sm" onClick={closeQRScanner} aria-label="Close scanner">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="relative bg-black rounded-lg overflow-hidden aspect-square">
          {qrScanError && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted/90 p-4 z-10">
              <div className="text-center">
                <AlertCircle className="h-8 w-8 mx-auto text-destructive mb-2" />
                <p className="text-sm text-destructive">{qrScanError}</p>
              </div>
            </div>
          )}

          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <canvas ref={canvasRef} className="hidden" />

          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-8 border-2 border-white/50 rounded-lg" />
          </div>
        </div>

        {availableCameras.length > 1 && (
          <Button variant="outline" size="sm" onClick={switchCamera} className="w-full">
            <RefreshCw className="h-4 w-4 mr-2" />
            Switch Camera
          </Button>
        )}

        <p className="text-xs text-muted-foreground text-center">
          {qrScannerMode === 'invite-code'
            ? 'Point camera at the invite code QR code'
            : 'Point camera at the pairing request QR code'}
        </p>
      </div>
    </div>
  )
}
