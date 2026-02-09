import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, AlertTriangle, QrCode, CheckCircle2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSend } from '@/contexts/send-context'
import { useNostrSend, type UseNostrSendReturn } from '@/hooks/use-nostr-send'
import { useManualSend, type UseManualSendReturn } from '@/hooks/use-manual-send'
import { PinDisplay } from '@/components/secure-send/pin-display'
import { TransferStatus } from '@/components/secure-send/transfer-status'
import { MultiQRDisplay } from '@/components/secure-send/multi-qr-display'
import { QRInput } from '@/components/secure-send/qr-input'
import { compressFilesToZip, getFolderName } from '@/lib/folder-utils'
import { testRelayAvailability } from '@/lib/nostr'

type TransferStep = 'checking' | 'compressing' | 'ready' | 'active' | 'complete' | 'error' | 'nostr_unavailable'

// Discriminated union for type-safe hook access
type ActiveHook =
  | { type: 'online'; hook: UseNostrSendReturn }
  | { type: 'offline'; hook: UseManualSendReturn }

// Helper to build FileList from array of Files
function buildFileListFromFiles(files: File[]): FileList {
  const dt = new DataTransfer()
  for (const file of files) {
    dt.items.add(file)
  }
  return dt.files
}

export function SendTransferPage() {
  const navigate = useNavigate()
  const { config, setConfig, clearConfig } = useSend()

  const [step, setStep] = useState<TransferStep>('checking')
  const [compressedFile, setCompressedFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Hooks for transfer
  const nostrHook = useNostrSend()
  const manualHook = useManualSend()

  const startedRef = useRef(false)

  // Determine which hook to use based on config with discriminated union
  const isOnline = config?.methodChoice === 'online'
  const activeHook: ActiveHook = useMemo(
    () => isOnline
      ? { type: 'online', hook: nostrHook }
      : { type: 'offline', hook: manualHook },
    [isOnline, nostrHook, manualHook]
  )

  // Extract common state from active hook
  const state = activeHook.hook.state
  const cancel = activeHook.hook.cancel

  // Online-specific properties (type-safe access)
  const pin = activeHook.type === 'online' ? activeHook.hook.pin : null

  // Offline-specific properties (type-safe access via discriminated union)
  const manualState = activeHook.type === 'offline' ? activeHook.hook.state : null
  const offerData = manualState?.offerData
  const clipboardData = manualState?.clipboardData
  const submitAnswer = activeHook.type === 'offline' ? activeHook.hook.submitAnswer : undefined

  // Redirect if no config
  useEffect(() => {
    if (!config) {
      void navigate('/', { replace: true })
    }
  }, [config, navigate])

  // Prepare file (compress if needed)
  useEffect(() => {
    if (!config || startedRef.current) return

    let cancelled = false

    const prepareFile = async () => {
      try {
        // Check Nostr availability first if needed
        if (config.methodChoice === 'online') {
          if (cancelled) return
          setStep('checking')
          const result = await testRelayAvailability()
          if (cancelled) return
          const available = result.available
          if (!available) {
            setStep('nostr_unavailable')
            return
          }
        }

        // Prepare file
        const files = config.folderFiles
          ? Array.from(config.folderFiles)
          : config.selectedFiles

        if (files.length === 0) {
          if (cancelled) return
          setError('No files selected')
          setStep('error')
          return
        }

        if (files.length === 1 && !config.folderFiles) {
          // Single file, no compression needed
          if (cancelled) return
          setCompressedFile(files[0])
          setStep('ready')
        } else {
          // Multiple files or folder, compress
          if (cancelled) return
          setStep('compressing')
          const archiveName = config.folderFiles
            ? getFolderName(config.folderFiles)
            : 'files'
          const fileList = config.folderFiles ?? buildFileListFromFiles(config.selectedFiles)
          const zipFile = await compressFilesToZip(fileList, archiveName)
          if (cancelled) return
          setCompressedFile(zipFile)
          setStep('ready')
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to prepare files')
        setStep('error')
      }
    }

    void prepareFile()

    return () => {
      cancelled = true
    }
  }, [config])

  // Start transfer when file is ready
  useEffect(() => {
    if (step !== 'ready' || !compressedFile || !config || startedRef.current) return

    startedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync step state when starting transfer
    setStep('active')

    if (activeHook.type === 'online') {
      const options = config.usePasskey
        ? {
            usePasskey: true,
            selfTransfer: true, // Passkey mode is always self-transfer
            relayOnly: config.relayOnly,
          }
        : { relayOnly: config.relayOnly }
      void activeHook.hook.send(compressedFile, options)
    } else {
      void activeHook.hook.send(compressedFile)
    }
  }, [step, compressedFile, config, activeHook])

  // Track completion - sync local step with hook state
  // Only apply state changes when transfer is active to avoid race conditions
  // after cancellation (handleSwitchToOffline, handleRetry set startedRef to false)
  useEffect(() => {
    if (!startedRef.current) return

    if (state.status === 'complete') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync step with hook completion
      setStep('complete')
    } else if (state.status === 'error') {
      // TypeScript narrows state to TransferStateError, so message is required
      setError(state.message)
      setStep('error')
    }
  }, [state])

  const handleCancel = useCallback(() => {
    cancel()
    clearConfig()
    void navigate('/')
  }, [cancel, clearConfig, navigate])

  const handleSwitchToOffline = useCallback(() => {
    if (!config) return
    // Cancel any active Nostr transfer before switching modes
    if (startedRef.current) {
      try {
        cancel()
      } catch (err) {
        console.error('Failed to cancel transfer:', err)
      }
    }
    // Update config to manual mode and restart the transfer flow
    startedRef.current = false
    setConfig({ ...config, methodChoice: 'offline' })
    setStep('checking')
    setError(null)
  }, [config, setConfig, cancel])

  const handleRetry = useCallback(() => {
    // Cancel any in-flight transfer before retrying
    if (startedRef.current) {
      try {
        cancel()
      } catch (err) {
        console.error('Failed to cancel transfer:', err)
      }
    }
    startedRef.current = false
    setStep('checking')
    setError(null)
  }, [cancel])

  const handleSendAnother = useCallback(() => {
    cancel()
    clearConfig()
    void navigate('/')
  }, [cancel, clearConfig, navigate])

  if (!config) {
    return null
  }

  // Render based on step
  return (
    <div className="space-y-6">
      {/* Checking Nostr availability */}
      {step === 'checking' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Checking connection...</p>
        </div>
      )}

      {/* Compressing files */}
      {step === 'compressing' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Compressing files...</p>
        </div>
      )}

      {/* Nostr unavailable */}
      {step === 'nostr_unavailable' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                Unable to connect to relay servers
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                You can switch to Manual mode (works offline) or retry the connection.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSwitchToOffline} className="flex-1" size="sm">
              <QrCode className="mr-2 h-4 w-4" />
              Switch to Manual
            </Button>
            <Button onClick={handleRetry} variant="outline" size="sm">
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Active transfer */}
      {step === 'active' && (
        <>
          {/* Manual mode: showing offer */}
          {!isOnline && offerData && submitAnswer && state.status === 'showing_offer' && (
            <div className="space-y-4">
              {/* Instructions at top */}
              <div className="rounded-lg bg-muted/50 border p-4 space-y-2">
                <p className="font-medium">Show these QR codes to the receiver</p>
                <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1">
                  <li>Receiver scans any QR code with their phone camera</li>
                  <li>App opens and guides scanning remaining codes</li>
                  <li>Receiver shows you their response QR code</li>
                  <li>You scan/paste their response below</li>
                </ol>
              </div>

              {/* QR codes */}
              <MultiQRDisplay data={offerData} clipboardData={clipboardData} />

              {/* Input for receiver's response */}
              <div className="pt-2 border-t">
                <p className="text-sm font-medium mb-3">Scan or paste receiver's response</p>
                <QRInput onSubmit={submitAnswer} expectedType="answer" />
              </div>
            </div>
          )}

          {/* Manual mode: other states (connecting, transferring, etc.) */}
          {!isOnline && state.status !== 'showing_offer' && (
            <TransferStatus state={state} />
          )}

          {/* Nostr mode: Transfer progress */}
          {isOnline && (
            <TransferStatus
              state={state}
              betweenProgressAndChunks={
                pin && state.status === 'waiting_for_receiver'
                  ? <PinDisplay pin={pin} passkeyFingerprint={null} onExpire={handleCancel} />
                  : undefined
              }
            />
          )}

          <Button onClick={handleCancel} variant="outline" className="w-full">
            Cancel
          </Button>
        </>
      )}

      {/* Complete */}
      {step === 'complete' && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="rounded-full bg-green-100 dark:bg-green-900/30 p-4">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <div className="text-center">
              <p className="font-medium text-lg">Transfer Complete!</p>
              <p className="text-muted-foreground text-sm">Your files have been sent successfully.</p>
            </div>
          </div>
          <Button onClick={handleSendAnother} className="w-full">
            <RotateCcw className="mr-2 h-4 w-4" />
            Send Another
          </Button>
        </div>
      )}

      {/* Error */}
      {step === 'error' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-destructive/10 border border-destructive/30 p-4">
            <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">Transfer Failed</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleRetry} className="flex-1">
              Retry
            </Button>
            <Button onClick={handleSendAnother} variant="outline">
              Start Over
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
