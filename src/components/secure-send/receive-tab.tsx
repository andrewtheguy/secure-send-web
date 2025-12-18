import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, X, RotateCcw, Check, Copy, FileDown, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PinInput, type PinInputRef } from './pin-input'
import { TransferStatus } from './transfer-status'
import { QRDisplay } from './qr-display'
import { QRInput } from './qr-input'
import { useNostrReceive } from '@/hooks/use-nostr-receive'
import { usePeerJSReceive } from '@/hooks/use-peerjs-receive'
import { useQRReceive } from '@/hooks/use-qr-receive'
import { downloadFile, formatFileSize, getMimeTypeDescription } from '@/lib/file-utils'
import { detectSignalingMethod } from '@/lib/crypto'
import type { SignalingMethod } from '@/lib/nostr/types'

const PIN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export function ReceiveTab() {
  // Store PIN in ref to avoid React DevTools exposure
  const pinRef = useRef('')
  const pinInputRef = useRef<PinInputRef>(null)
  const [isPinValid, setIsPinValid] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [pinExpired, setPinExpired] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(0)
  const [detectedMethod, setDetectedMethod] = useState<SignalingMethod>('nostr')

  // All hooks must be called unconditionally (React rules)
  const nostrHook = useNostrReceive()
  const peerJSHook = usePeerJSReceive()
  const qrHook = useQRReceive()

  // Use the appropriate hook based on detected signaling method from PIN
  const activeHook = detectedMethod === 'nostr' ? nostrHook : detectedMethod === 'peerjs' ? peerJSHook : qrHook
  const { state: rawState, receivedContent, receive, cancel, reset } = activeHook
  const submitOffer = detectedMethod === 'qr' ? qrHook.submitOffer : undefined

  // Normalize state for QR hook (it has additional status values)
  const state = rawState as typeof nostrHook.state & { answerQRData?: string[]; clipboardData?: string }

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinInactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  // Clear PIN inactivity timeout and countdown
  const clearPinInactivityTimeout = useCallback(() => {
    if (pinInactivityRef.current) {
      clearTimeout(pinInactivityRef.current)
      pinInactivityRef.current = null
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    setTimeRemaining(0)
  }, [])

  // Reset PIN inactivity timeout (called on each PIN change)
  const resetPinInactivityTimeout = useCallback(() => {
    clearPinInactivityTimeout()
    setPinExpired(false)

    // Only set timeout if there's some PIN input
    if (pinRef.current.length > 0) {
      // Set initial countdown time
      setTimeRemaining(Math.floor(PIN_INACTIVITY_TIMEOUT_MS / 1000))

      // Start countdown interval
      countdownIntervalRef.current = setInterval(() => {
        if (!mountedRef.current) return
        setTimeRemaining(prev => Math.max(0, prev - 1))
      }, 1000)

      // Set expiration timeout
      pinInactivityRef.current = setTimeout(() => {
        if (mountedRef.current && pinRef.current.length > 0) {
          // Clear PIN due to inactivity
          pinRef.current = ''
          setIsPinValid(false)
          pinInputRef.current?.clear()
          setPinExpired(true)
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current)
            countdownIntervalRef.current = null
          }
          setTimeRemaining(0)
        }
      }, PIN_INACTIVITY_TIMEOUT_MS)
    }
  }, [clearPinInactivityTimeout])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Clear PIN from memory on unmount
      pinRef.current = ''
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
      }
      clearPinInactivityTimeout()
    }
  }, [clearPinInactivityTimeout])

  // Format time remaining as MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const canReceive = isPinValid && state.status === 'idle'

  const handleReceive = () => {
    if (canReceive && pinRef.current) {
      clearPinInactivityTimeout()
      const pin = pinRef.current
      // Clear PIN immediately after getting it
      pinRef.current = ''
      setIsPinValid(false)
      pinInputRef.current?.clear()
      setPinExpired(false)
      // Pass PIN to receive function
      receive(pin)
    }
  }

  const handleReset = () => {
    reset()
    clearPinInactivityTimeout()
    // Clear PIN from ref and input
    pinRef.current = ''
    setIsPinValid(false)
    pinInputRef.current?.clear()
    setCopied(false)
    setCopyError(false)
    setPinExpired(false)
  }

  const handlePinChange = useCallback((pin: string, isValid: boolean) => {
    pinRef.current = pin
    setIsPinValid(isValid)
    resetPinInactivityTimeout()

    // Auto-detect signaling method from PIN's first character
    if (pin.length > 0) {
      const method = detectSignalingMethod(pin)
      if (method) {
        setDetectedMethod(method)
      }
    }
  }, [resetPinInactivityTimeout])

  const handleCopy = useCallback(async () => {
    if (receivedContent?.contentType !== 'text') return

    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    try {
      await navigator.clipboard.writeText(receivedContent.message)
      if (!mountedRef.current) return

      setCopyError(false)
      setCopied(true)
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setCopied(false)
        }
      }, 2000)
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
      if (!mountedRef.current) return

      setCopied(false)
      setCopyError(true)
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setCopyError(false)
        }
      }, 2000)
    }
  }, [receivedContent])

  const handleDownload = () => {
    if (receivedContent?.contentType === 'file') {
      downloadFile(receivedContent.data, receivedContent.fileName, receivedContent.mimeType)
    }
  }

  const isActive = state.status !== 'idle' && state.status !== 'error' && state.status !== 'complete'
  const showQRInput = detectedMethod === 'qr' && state.status === 'waiting_for_offer'
  const showQRDisplay = detectedMethod === 'qr' && state.answerQRData && state.status === 'showing_answer_qr'

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium">Enter PIN from sender</label>
            <PinInput ref={pinInputRef} onPinChange={handlePinChange} disabled={isActive} />
            {timeRemaining > 0 && (
              <p className="text-xs text-amber-600 font-medium">
                PIN will be cleared in {formatTime(timeRemaining)}
              </p>
            )}
            {pinExpired && (
              <p className="text-xs text-muted-foreground">
                PIN cleared due to inactivity. Please re-enter.
              </p>
            )}
            {detectedMethod === 'qr' && isPinValid && (
              <p className="text-xs text-muted-foreground">
                QR mode detected. You'll scan the sender's QR code next.
              </p>
            )}
          </div>

          <Button onClick={handleReceive} disabled={!canReceive} className="w-full">
            <Download className="mr-2 h-4 w-4" />
            Receive
          </Button>
        </>
      ) : (
        <>
          <TransferStatus state={state} />

          {/* QR Input for receiving offer */}
          {showQRInput && submitOffer && (
            <div className="space-y-4">
              <QRInput
                expectedType="offer"
                label="Scan sender's QR code and paste the data below"
                onSubmit={submitOffer}
              />
            </div>
          )}

          {/* QR Code display for receiver's answer */}
          {showQRDisplay && state.answerQRData && (
            <div className="space-y-4">
              <QRDisplay
                data={state.answerQRData}
                clipboardData={state.clipboardData}
                label="Show this QR to sender and wait for connection"
              />
            </div>
          )}

          {state.status === 'complete' && receivedContent?.contentType === 'text' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Received Message</label>
                <Button variant="ghost" size="sm" onClick={handleCopy}>
                  {copied ? (
                    <>
                      <Check className="mr-1 h-3 w-3 text-green-500" />
                      Copied
                    </>
                  ) : copyError ? (
                    <>
                      <AlertCircle className="mr-1 h-3 w-3 text-destructive" />
                      Failed
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-3 w-3" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              <Textarea
                value={receivedContent.message}
                readOnly
                className="min-h-[200px] font-mono bg-muted"
              />
            </div>
          )}

          {state.status === 'complete' && receivedContent?.contentType === 'file' && (
            <div className="space-y-4">
              <div className="p-6 border rounded-lg bg-muted/50 text-center space-y-3">
                <FileDown className="h-12 w-12 mx-auto text-muted-foreground" />
                <div>
                  <p className="font-medium truncate max-w-[300px] mx-auto">
                    {receivedContent.fileName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatFileSize(receivedContent.fileSize)} &bull;{' '}
                    {getMimeTypeDescription(receivedContent.mimeType)}
                  </p>
                </div>
                <Button onClick={handleDownload} className="w-full max-w-[200px]">
                  <Download className="mr-2 h-4 w-4" />
                  Download File
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            {isActive && (
              <Button variant="outline" onClick={cancel} className="flex-1">
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            )}

            {(state.status === 'complete' || state.status === 'error') && (
              <Button variant="outline" onClick={handleReset} className="flex-1">
                <RotateCcw className="mr-2 h-4 w-4" />
                Receive Another
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
