import { useRef, useEffect, useCallback, useState } from 'react'
import { isMobileDevice } from '@/lib/utils'
import ZXingWorker from '@/workers/zxing-qr-scanner.worker?worker'

interface UseQRScannerOptions {
  onScan: (data: Uint8Array) => void
  onError?: (error: string) => void
  onCameraReady?: () => void
  isScanning: boolean
  facingMode?: 'environment' | 'user'
  scanInterval?: number
  debounceMs?: number
  preferLowRes?: boolean
}

export function useQRScanner(options: UseQRScannerOptions) {
  const {
    onScan,
    onError,
    onCameraReady,
    isScanning,
    facingMode = 'environment',
    scanInterval = 33, // Faster for better QR detection
    debounceMs = 500,
    preferLowRes = true, // Default true for QR scanning
  } = options

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scanLoopRef = useRef<number | null>(null)
  const isScanningRef = useRef<boolean>(false)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([])

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter((device) => device.kind === 'videoinput')
      setAvailableCameras(videoDevices)
    } catch (err) {
      console.error('Failed to enumerate cameras:', err)
    }
  }, [])

  // Initialize worker
  useEffect(() => {
    const worker = new ZXingWorker()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'result') {
        if (e.data.data && Array.isArray(e.data.data) && e.data.data.length > 0) {
          const scannedData = e.data.data[0] as Uint8Array
          const now = Date.now()

          // Create hash for debouncing binary data
          const dataHash = Array.from(scannedData.slice(0, 32)).join(',')

          // Debounce duplicate scans
          if (debounceMs > 0 && dataHash === lastScannedRef.current && now - lastScanTimeRef.current < debounceMs) {
            return
          }

          lastScannedRef.current = dataHash
          lastScanTimeRef.current = now

          onScan(scannedData)
        }
        if (e.data.error) {
          console.error('Worker decode error:', e.data.error)
        }
      }
    }

    worker.onerror = (err) => {
      console.error('Worker error:', err)
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [onScan, debounceMs])

  const scanVideoFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !workerRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current

    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      return
    }

    try {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      if (canvas.width === 0 || canvas.height === 0) {
        return
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

      // Send to worker with binary mode enabled
      workerRef.current.postMessage(
        {
          type: 'scan',
          imageData,
          binary: true, // Always use binary mode for gzipped data
        },
        [imageData.data.buffer]
      )
    } catch (err) {
      console.error('Error scanning frame:', err)
    }
  }, [])

  const startScanLoop = useCallback(() => {
    let lastScanTime = 0

    const scanFrame = () => {
      if (!isScanningRef.current) {
        return
      }

      const now = Date.now()
      if (now - lastScanTime >= scanInterval) {
        scanVideoFrame()
        lastScanTime = now
      }

      if (isScanningRef.current) {
        scanLoopRef.current = requestAnimationFrame(scanFrame)
      }
    }

    isScanningRef.current = true
    scanFrame()
  }, [scanInterval, scanVideoFrame])

  const stopCameraScanning = useCallback(() => {
    isScanningRef.current = false

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current)
      scanLoopRef.current = null
    }
  }, [])

  const startCameraScanning = useCallback(async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))

      if (!videoRef.current) {
        throw new Error('Video element not available')
      }

      const isMobile = isMobileDevice()
      const constraints: MediaStreamConstraints = {
        video: isMobile
          ? {
              facingMode: facingMode,
              width: { ideal: preferLowRes ? 640 : 1280 },
              height: { ideal: preferLowRes ? 480 : 720 },
            }
          : {
              facingMode: facingMode,
            },
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      cameraStreamRef.current = stream
      videoRef.current.srcObject = stream

      await videoRef.current.play()
      await enumerateCameras()

      if (onCameraReady) {
        onCameraReady()
      }

      startScanLoop()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to access camera'
      if (onError) {
        onError(`Camera access denied or unavailable. ${errorMessage}`)
      }
      isScanningRef.current = false
    }
  }, [facingMode, preferLowRes, enumerateCameras, onCameraReady, onError, startScanLoop])

  const switchCamera = useCallback(async () => {
    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current)
      scanLoopRef.current = null
    }

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
    await startCameraScanning()
  }, [startCameraScanning])

  // Start/stop scanning based on isScanning prop
  useEffect(() => {
    if (isScanning && !isScanningRef.current) {
      startCameraScanning()
    } else if (!isScanning && isScanningRef.current) {
      stopCameraScanning()
    }
  }, [isScanning, startCameraScanning, stopCameraScanning])

  // Restart camera when facingMode or preferLowRes changes
  const facingModeRef = useRef(facingMode)
  const preferLowResRef = useRef(preferLowRes)
  useEffect(() => {
    const facingModeChanged = facingModeRef.current !== facingMode
    const preferLowResChanged = preferLowResRef.current !== preferLowRes

    if ((facingModeChanged || preferLowResChanged) && isScanningRef.current) {
      switchCamera()
    }

    facingModeRef.current = facingMode
    preferLowResRef.current = preferLowRes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode, preferLowRes])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isScanningRef.current = false
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (scanLoopRef.current !== null) {
        cancelAnimationFrame(scanLoopRef.current)
      }
      if (videoRef.current) {
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.srcObject = null
          }
        }, 50)
      }
    }
  }, [])

  return {
    videoRef,
    canvasRef,
    switchCamera,
    availableCameras,
  }
}
