import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, X, RotateCcw, FileDown, QrCode, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PinInput, type PinInputRef } from './pin-input'
import { TransferStatus } from './transfer-status'
import { QRDisplay } from './qr-display'
import { QRInput } from './qr-input'
import { useNostrReceive } from '@/hooks/use-nostr-receive'
import { usePeerJSReceive } from '@/hooks/use-peerjs-receive'
import { useManualReceive } from '@/hooks/use-manual-receive'
import { downloadFile, formatFileSize, getMimeTypeDescription } from '@/lib/file-utils'
import { detectSignalingMethod } from '@/lib/crypto'
import type { SignalingMethod } from '@/lib/nostr/types'

const PIN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

type ReceiveMode = 'pin' | 'scan'

export function ReceiveTab() {
  const [receiveMode, setReceiveMode] = useState<ReceiveMode>('pin')

  // Store PIN in ref to avoid React DevTools exposure
  const pinRef = useRef('')
  const pinInputRef = useRef<PinInputRef>(null)
  const [isPinValid, setIsPinValid] = useState(false)
  const [pinExpired, setPinExpired] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(0)
  const [detectedMethod, setDetectedMethod] = useState<SignalingMethod>('nostr')

  // All hooks must be called unconditionally (React rules)
  const nostrHook = useNostrReceive()
  const peerJSHook = usePeerJSReceive()
  const manualHook = useManualReceive()

  // Determine which hook to use based on mode
  const isManualMode = receiveMode === 'scan'

  const getActiveHook = () => {
    if (isManualMode) return manualHook
    if (detectedMethod === 'nostr') return nostrHook
    if (detectedMethod === 'peerjs') return peerJSHook
    return nostrHook // default fallback
  }
  const activeHook = getActiveHook()

  const { state: rawState, receivedContent, cancel, reset } = activeHook

  // Get the right receive function based on mode
  // nostrHook and peerJSHook have .receive, manualHook does not
  const pinReceive: ((pin: string) => void) | undefined =
    !isManualMode && 'receive' in activeHook && typeof activeHook.receive === 'function'
      ? activeHook.receive
      : undefined
  const { startReceive, submitOffer } = manualHook

  // Use rawState directly for common properties
  const state = rawState

  // Runtime normalization for manual-mode specific properties
  const rawStateAny = rawState as unknown as Record<string, unknown>
  const answerData: Uint8Array | undefined =
    rawStateAny.answerData instanceof Uint8Array
      ? rawStateAny.answerData
      : undefined
  const clipboardData: string | undefined =
    typeof rawStateAny.clipboardData === 'string'
      ? rawStateAny.clipboardData
      : undefined

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
      const timeoutId = timeoutRef.current
      const countdownId = countdownIntervalRef.current
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (countdownId) {
        clearInterval(countdownId)
      }
      timeoutRef.current = null
      countdownIntervalRef.current = null
      clearPinInactivityTimeout()
    }
  }, [clearPinInactivityTimeout])

  // Format time remaining as MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const canReceivePin = isPinValid && state.status === 'idle'
  const canReceiveScan = state.status === 'idle'

  const handleReceivePin = () => {
    if (canReceivePin && pinRef.current && pinReceive) {
      clearPinInactivityTimeout()
      const pin = pinRef.current
      // Clear PIN immediately after getting it
      pinRef.current = ''
      setIsPinValid(false)
      pinInputRef.current?.clear()
      setPinExpired(false)
      // Pass PIN to receive function
      pinReceive(pin)
    }
  }

  const handleReceiveScan = () => {
    if (canReceiveScan) {
      startReceive()
    }
  }

  const handleReset = () => {
    reset()
    clearPinInactivityTimeout()
    // Clear PIN from ref and input
    pinRef.current = ''
    setIsPinValid(false)
    pinInputRef.current?.clear()
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

  const handleDownload = () => {
    if (receivedContent) {
      downloadFile(receivedContent.data, receivedContent.fileName, receivedContent.mimeType)
    }
  }

  const isActive = state.status !== 'idle' && state.status !== 'error' && state.status !== 'complete'
  const showQRInput = isManualMode && state.status === 'waiting_for_offer'
  const showQRDisplay = isManualMode && answerData && state.status === 'showing_answer'

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <Tabs value={receiveMode} onValueChange={(v) => setReceiveMode(v as ReceiveMode)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="pin" className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                Enter PIN
              </TabsTrigger>
              <TabsTrigger value="scan" className="flex items-center gap-2">
                <QrCode className="h-4 w-4" />
                Scan Code
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {receiveMode === 'pin' ? (
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
              </div>

              <Button onClick={handleReceivePin} disabled={!canReceivePin} className="w-full">
                <Download className="mr-2 h-4 w-4" />
                Receive
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Scan or paste the sender's code to receive their content. No PIN required.
                </p>
              </div>

              <Button onClick={handleReceiveScan} disabled={!canReceiveScan} className="w-full">
                <Download className="mr-2 h-4 w-4" />
                Start Receive
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <TransferStatus state={state} />

          {/* QR Input for receiving offer */}
          {showQRInput && (
            <div className="space-y-4">
              <QRInput
                expectedType="offer"
                label="Scan or paste the sender's code"
                onSubmit={submitOffer}
              />
            </div>
          )}

          {/* QR Code display for receiver's answer */}
          {showQRDisplay && answerData && (
            <div className="space-y-4">
              <QRDisplay
                data={answerData}
                clipboardData={clipboardData}
                label="Show this to sender and wait for connection"
              />
            </div>
          )}

          {state.status === 'complete' && receivedContent && (
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
