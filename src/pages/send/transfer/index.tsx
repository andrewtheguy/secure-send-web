import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, AlertTriangle, QrCode, CheckCircle2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSend } from '@/contexts/send-context'
import { useNostrSend } from '@/hooks/use-nostr-send'
import { useManualSend } from '@/hooks/use-manual-send'
import { PinDisplay } from '@/components/secure-send/pin-display'
import { TransferStatus } from '@/components/secure-send/transfer-status'
import { QRDisplay } from '@/components/secure-send/qr-display'
import { QRInput } from '@/components/secure-send/qr-input'
import { compressFilesToZip, getFolderName } from '@/lib/folder-utils'
import { testRelayAvailability } from '@/lib/nostr'

type TransferStep = 'checking' | 'compressing' | 'ready' | 'active' | 'complete' | 'error' | 'nostr_unavailable'

export function SendTransferPage() {
  const navigate = useNavigate()
  const { config, clearConfig } = useSend()

  const [step, setStep] = useState<TransferStep>('checking')
  const [compressedFile, setCompressedFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Hooks for transfer
  const nostrHook = useNostrSend()
  const manualHook = useManualSend()

  const startedRef = useRef(false)

  // Determine which hook to use based on config
  const isNostr = config?.methodChoice === 'nostr'
  const activeHook = isNostr ? nostrHook : manualHook

  // Extract state from active hook
  const { state, cancel } = activeHook
  const pin = isNostr && 'pin' in activeHook ? activeHook.pin : null
  const ownFingerprint = isNostr && 'ownFingerprint' in activeHook ? activeHook.ownFingerprint : null

  // Manual mode specific state
  const rawState = state as unknown as Record<string, unknown>
  const offerData = rawState.offerData instanceof Uint8Array ? rawState.offerData : undefined
  const clipboardData = typeof rawState.clipboardData === 'string' ? rawState.clipboardData : undefined
  const submitAnswer = !isNostr ? manualHook.submitAnswer : undefined

  // Redirect if no config
  useEffect(() => {
    if (!config) {
      navigate('/', { replace: true })
    }
  }, [config, navigate])

  // Prepare file (compress if needed)
  useEffect(() => {
    if (!config || startedRef.current) return

    const prepareFile = async () => {
      try {
        // Check Nostr availability first if needed
        if (config.methodChoice === 'nostr') {
          setStep('checking')
          const result = await testRelayAvailability()
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
          setError('No files selected')
          setStep('error')
          return
        }

        if (files.length === 1 && !config.folderFiles) {
          // Single file, no compression needed
          setCompressedFile(files[0])
          setStep('ready')
        } else {
          // Multiple files or folder, compress
          setStep('compressing')
          const archiveName = config.folderFiles
            ? getFolderName(config.folderFiles)
            : 'files'
          const fileList = config.folderFiles || (() => {
            const dt = new DataTransfer()
            config.selectedFiles.forEach(f => dt.items.add(f))
            return dt.files
          })()
          const zipFile = await compressFilesToZip(fileList, archiveName)
          setCompressedFile(zipFile)
          setStep('ready')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to prepare files')
        setStep('error')
      }
    }

    prepareFile()
  }, [config])

  // Start transfer when file is ready
  useEffect(() => {
    if (step !== 'ready' || !compressedFile || !config || startedRef.current) return

    startedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync step state when starting transfer
    setStep('active')

    const options = config.usePasskey
      ? {
          receiverPairingKey: config.receiverPublicKeyInput || undefined,
          selfTransfer: config.sendToSelf,
          relayOnly: config.relayOnly,
        }
      : { relayOnly: config.relayOnly }

    if (isNostr) {
      nostrHook.send(compressedFile, options)
    } else {
      manualHook.send(compressedFile)
    }
  }, [step, compressedFile, config, isNostr, nostrHook, manualHook])

  // Track completion - sync local step with hook state
  useEffect(() => {
    if (state.status === 'complete') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync step with hook completion
      setStep('complete')
    } else if (state.status === 'error') {
      setError((state as { error?: string }).error || 'Transfer failed')
      setStep('error')
    }
  }, [state])

  const handleCancel = useCallback(() => {
    cancel()
    clearConfig()
    navigate('/')
  }, [cancel, clearConfig, navigate])

  const handleSwitchToManual = useCallback(() => {
    if (!config) return
    // Update config to manual and restart
    // For now, just go back
    clearConfig()
    navigate('/')
  }, [config, clearConfig, navigate])

  const handleRetry = useCallback(() => {
    startedRef.current = false
    setStep('checking')
    setError(null)
  }, [])

  const handleSendAnother = useCallback(() => {
    cancel()
    clearConfig()
    navigate('/')
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
            <Button onClick={handleSwitchToManual} className="flex-1" size="sm">
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
          {/* PIN display for Nostr mode */}
          {isNostr && pin && state.status === 'waiting_for_receiver' && (
            <PinDisplay pin={pin} passkeyFingerprint={null} onExpire={handleCancel} />
          )}

          {/* QR display/input for Manual mode */}
          {!isNostr && offerData && state.status === 'showing_offer' && (
            <div className="space-y-4">
              <QRDisplay data={offerData} clipboardData={clipboardData || ''} />
              <QRInput onSubmit={submitAnswer!} expectedType="answer" />
            </div>
          )}

          {/* Transfer progress */}
          <TransferStatus
            state={state}
            betweenProgressAndChunks={
              isNostr && pin && state.status === 'waiting_for_receiver'
                ? <PinDisplay pin={pin} passkeyFingerprint={null} onExpire={handleCancel} />
                : undefined
            }
          />

          {/* Sender fingerprint in passkey mode */}
          {isNostr && ownFingerprint && config.usePasskey && (
            <div className="text-xs text-muted-foreground border border-cyan-500/30 bg-cyan-50/30 dark:bg-cyan-950/20 px-3 py-2 rounded">
              <p>Your fingerprint: <span className="font-mono font-medium text-cyan-600">{ownFingerprint}</span></p>
              <p className="mt-1">Receiver should verify this matches your public ID.</p>
            </div>
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
