import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, X, RotateCcw, FileUp, Upload, Cloud, FolderUp, Loader2, ChevronDown, ChevronRight, QrCode, AlertTriangle, Info, Fingerprint, ArrowRight, Keyboard, Camera, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PinDisplay } from './pin-display'
import { TransferStatus } from './transfer-status'
import { QRDisplay } from './qr-display'
import { QRInput } from './qr-input'
import { useNostrSend } from '@/hooks/use-nostr-send'
import { useManualSend } from '@/hooks/use-manual-send'
import { MAX_MESSAGE_SIZE } from '@/lib/crypto'
import { formatFileSize } from '@/lib/file-utils'
import { compressFilesToZip, getFolderName, getTotalSize, supportsFolderSelection } from '@/lib/folder-utils'
import type { SignalingMethod } from '@/lib/nostr/types'
import { Link } from 'react-router-dom'
import { formatFingerprint } from '@/lib/crypto/ecdh'
import { isPairingKeyFormat, parsePairingKey, type ParsedPairingKey } from '@/lib/crypto/pairing-key'
import { getSavedPairingKeys, savePairingKey, type SavedPairingKey } from '@/lib/saved-pairing-keys'
import { useQRScanner } from '@/hooks/useQRScanner'
import { isMobileDevice } from '@/lib/utils'

type ContentMode = 'file' | 'folder'
type MethodChoice = 'nostr' | 'manual'

// Extend input element to include webkitdirectory attribute
declare module 'react' {
  interface InputHTMLAttributes<T = HTMLInputElement> {
    webkitdirectory?: T extends HTMLInputElement ? string : never
    directory?: T extends HTMLInputElement ? string : never
  }
}

export function SendTab() {
  const [mode, setMode] = useState<ContentMode>('file')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [methodChoice, setMethodChoice] = useState<MethodChoice>('nostr')
  const [usePasskey, setUsePasskey] = useState(false)
  const [sendToSelf, setSendToSelf] = useState(false)
  const [activeMethod, setActiveMethod] = useState<SignalingMethod | null>(null)
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [folderFiles, setFolderFiles] = useState<FileList | null>(null) // Keep FileList for folder to preserve paths
  const [isCompressing, setIsCompressing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [checkingNostr, setCheckingNostr] = useState(false)
  const [nostrUnavailable, setNostrUnavailable] = useState(false)
  const [receiverPublicKeyInput, setReceiverPublicKeyInput] = useState('')
  const [receiverPublicKeyError, setReceiverPublicKeyError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  // Parsed pairing key state (updated via useEffect since parsing is async)
  const [parsedPairingKey, setParsedPairingKey] = useState<ParsedPairingKey | null>(null)

  // Saved pairing keys for quick selection
  const [savedPairingKeys, setSavedPairingKeys] = useState<SavedPairingKey[]>([])
  const [showPairingKeyDropdown, setShowPairingKeyDropdown] = useState(false)
  const [loadedFromHistory, setLoadedFromHistory] = useState(false)

  // QR scanner state for pairing key scanning
  const [showPairingKeyQRScanner, setShowPairingKeyQRScanner] = useState(false)
  const [pairingKeyQRError, setPairingKeyQRError] = useState<string | null>(null)
  const [pairingKeyCameraReady, setPairingKeyCameraReady] = useState(false)
  const [selectedPairingKeyCamera, setSelectedPairingKeyCamera] = useState<string>(
    isMobileDevice() ? 'environment' : 'user'
  )

  // QR scanner handlers
  const handlePairingKeyQRScan = useCallback((data: Uint8Array) => {
    // Decode bytes to string (pairing keys are JSON text)
    const text = new TextDecoder().decode(data)
    // Check if it looks like a pairing key
    if (isPairingKeyFormat(text)) {
      setReceiverPublicKeyInput(text)
      setLoadedFromHistory(false)
      setShowPairingKeyQRScanner(false)
      setPairingKeyQRError(null)
    } else {
      setPairingKeyQRError('Not a valid pairing key')
    }
  }, [])

  const handlePairingKeyQRError = useCallback((error: string) => {
    setPairingKeyQRError(error)
  }, [])

  const handlePairingKeyCameraReady = useCallback(() => {
    setPairingKeyCameraReady(true)
    setPairingKeyQRError(null)
  }, [])

  const { videoRef: pairingKeyVideoRef, canvasRef: pairingKeyCanvasRef, availableCameras: pairingKeyAvailableCameras } = useQRScanner({
    onScan: handlePairingKeyQRScan,
    onError: handlePairingKeyQRError,
    onCameraReady: handlePairingKeyCameraReady,
    facingMode: selectedPairingKeyCamera as 'environment' | 'user',
    isScanning: showPairingKeyQRScanner,
  })

  // Reset pairingKeyCameraReady when scanner closes
  useEffect(() => {
    if (!showPairingKeyQRScanner) {
      setPairingKeyCameraReady(false)
    }
  }, [showPairingKeyQRScanner])

  // Reset pairingKeyCameraReady when camera selection changes while scanner is open
  useEffect(() => {
    if (showPairingKeyQRScanner) {
      setPairingKeyCameraReady(false)
    }
  }, [selectedPairingKeyCamera, showPairingKeyQRScanner])

  // Parse pairing key - debounced to reduce parsing on every keystroke
  useEffect(() => {
    let cancelled = false

    const input = receiverPublicKeyInput.trim()
    if (!input) {
      setParsedPairingKey(null)
      setReceiverPublicKeyError(null)
      return
    }

    // Quick format check first (synchronous, no debounce needed)
    if (!isPairingKeyFormat(input)) {
      setParsedPairingKey(null)
      setReceiverPublicKeyError('Invalid format: expected pairing key (create one on the Passkey page)')
      return
    }

    // Debounce the async parsing
    const timeoutId = setTimeout(() => {
      parsePairingKey(input)
        .then((parsed) => {
          if (cancelled) return
          setParsedPairingKey(parsed)
          setReceiverPublicKeyError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setParsedPairingKey(null)
          setReceiverPublicKeyError(err instanceof Error ? err.message : 'Invalid pairing key format')
        })
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [receiverPublicKeyInput])

  // Load saved pairing keys when passkey mode is enabled
  useEffect(() => {
    if (usePasskey) {
      setSavedPairingKeys(getSavedPairingKeys())
    }
  }, [usePasskey])

  // All hooks must be called unconditionally (React rules)
  const nostrHook = useNostrSend()
  const manualHook = useManualSend()

  // Use the appropriate hook based on active method (defaults to nostr before detection)
  const activeHook = activeMethod === 'manual' ? manualHook : nostrHook

  // Only nostr hook has PIN - use runtime check for type safety
  const pin: string | null =
    activeMethod !== 'manual' && 'pin' in activeHook && typeof activeHook.pin === 'string'
      ? activeHook.pin
      : null
  // Only nostr hook has ownFingerprint for mutual trust mode
  const senderFingerprint: string | null =
    activeMethod === 'nostr' && 'ownFingerprint' in activeHook && typeof activeHook.ownFingerprint === 'string'
      ? activeHook.ownFingerprint
      : null
  const { state: rawState, cancel } = activeHook
  const submitAnswer = activeMethod === 'manual' ? manualHook.submitAnswer : undefined

  // Runtime normalization for manual-mode specific properties
  const state = rawState
  const rawStateAny = rawState as unknown as Record<string, unknown>
  const offerData: Uint8Array | undefined =
    rawStateAny.offerData instanceof Uint8Array ? rawStateAny.offerData : undefined
  const clipboardData: string | undefined =
    typeof rawStateAny.clipboardData === 'string' ? rawStateAny.clipboardData : undefined

  // Save pairing key to localStorage on successful transfer (passkey mode with pairing key)
  useEffect(() => {
    if (
      state.status === 'complete' &&
      usePasskey &&
      !sendToSelf &&
      parsedPairingKey &&
      receiverPublicKeyInput.trim()
    ) {
      savePairingKey(
        receiverPublicKeyInput.trim(),
        parsedPairingKey.partyAFingerprint,
        parsedPairingKey.partyBFingerprint,
        parsedPairingKey.comment
      )
      // Refresh saved pairing keys list
      setSavedPairingKeys(getSavedPairingKeys())
    }
  }, [state.status, usePasskey, sendToSelf, parsedPairingKey, receiverPublicKeyInput])

  const filesTotalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)
  const folderTotalSize = folderFiles ? getTotalSize(folderFiles) : 0
  const isFilesOverLimit = filesTotalSize > MAX_MESSAGE_SIZE
  const isFolderOverLimit = folderTotalSize > MAX_MESSAGE_SIZE

  const canSendFiles = selectedFiles.length > 0 && !isFilesOverLimit && state.status === 'idle' && !isCompressing
  const canSendFolder = folderFiles && folderFiles.length > 0 && !isFolderOverLimit && state.status === 'idle' && !isCompressing
  // When passkey mode is enabled, require valid receiver pairing key OR sendToSelf
  const passkeyRequirementsMet = !usePasskey || sendToSelf || (parsedPairingKey !== null)
  const canSend = (mode === 'file' ? canSendFiles : canSendFolder) && passkeyRequirementsMet

  const handleSend = async () => {
    // Use the user's selected method
    const methodToUse = methodChoice

    // Check Nostr availability if that method is selected
    if (methodToUse === 'nostr') {
      setCheckingNostr(true)
      setNostrUnavailable(false)
      try {
        const { testRelayAvailability } = await import('@/lib/nostr')
        const nostrResult = await testRelayAvailability()

        if (!nostrResult.available) {
          // Nostr unavailable - suggest user to switch to manual mode
          console.log('Nostr unavailable, suggesting manual mode', nostrResult)
          setCheckingNostr(false)
          setNostrUnavailable(true)
          return
        }
        console.log('Nostr available', nostrResult)
      } catch (error) {
        // If test fails, suggest manual mode
        console.error('Nostr availability test failed:', error)
        setCheckingNostr(false)
        setNostrUnavailable(true)
        return
      }
      setCheckingNostr(false)
    }

    setActiveMethod(methodToUse)

    // Only Nostr hook supports relayOnly and usePasskey options
    // Pass receiver pairing key when in passkey mode (unless sending to self)
    // Pairing key will be verified at send time when passkey authenticates
    const sendOptions = methodToUse === 'nostr'
      ? {
          relayOnly,
          usePasskey,
          selfTransfer: usePasskey && sendToSelf,
          receiverPairingKey: usePasskey && !sendToSelf && receiverPublicKeyInput.trim() ? receiverPublicKeyInput.trim() : undefined,
        }
      : undefined

    const doSend = (content: File) => {
      if (methodToUse === 'nostr') {
        nostrHook.send(content, sendOptions)
      } else {
        manualHook.send(content)
      }
    }

    if (mode === 'file' && canSendFiles) {
      // Single file: send directly
      if (selectedFiles.length === 1) {
        doSend(selectedFiles[0])
        return
      }
      // Multiple files: compress to ZIP
      setIsCompressing(true)
      try {
        const dataTransfer = new DataTransfer()
        selectedFiles.forEach(f => dataTransfer.items.add(f))
        const zipFile = await compressFilesToZip(dataTransfer.files, 'files')
        setIsCompressing(false)
        doSend(zipFile)
      } catch (err) {
        setIsCompressing(false)
        console.error('Failed to compress files:', err)
      }
    } else if (mode === 'folder' && canSendFolder && folderFiles) {
      setIsCompressing(true)
      try {
        const archiveName = getFolderName(folderFiles)
        const zipFile = await compressFilesToZip(folderFiles, archiveName)
        setIsCompressing(false)
        doSend(zipFile)
      } catch (err) {
        setIsCompressing(false)
        console.error('Failed to compress folder:', err)
      }
    }
  }

  const handleReset = () => {
    nostrHook.cancel()
    manualHook.cancel()
    setSelectedFiles([])
    setFolderFiles(null)
    setActiveMethod(null)
    setNostrUnavailable(false)
    setReceiverPublicKeyInput('')
    setReceiverPublicKeyError(null)
    setParsedPairingKey(null)
    setSendToSelf(false)
    setLoadedFromHistory(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (folderInputRef.current) folderInputRef.current.value = ''
  }

  const handleSwitchToManual = () => {
    setNostrUnavailable(false)
    setMethodChoice('manual')
    setShowAdvanced(true) // Show advanced options so user sees the change
  }

  const handleRetryNostr = () => {
    setNostrUnavailable(false)
    // Re-trigger send which will re-check availability
    handleSend()
  }

  const addFiles = useCallback((files: File[]) => {
    if (files.length > 0) {
      // Add to existing files, avoiding duplicates by name+size
      setSelectedFiles(prev => {
        const existingKeys = new Set(prev.map(f => `${f.name}-${f.size}`))
        const uniqueNew = files.filter(f => !existingKeys.has(`${f.name}-${f.size}`))
        return [...prev, ...uniqueNew]
      })
    }
  }, [])

  const removeFile = useCallback((index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Convert FileList to array BEFORE resetting input (FileList is a live reference)
    const files = e.target.files ? Array.from(e.target.files) : []
    addFiles(files)
    // Reset input so same file can be added again if removed
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFolderFiles(e.target.files)
    }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)
    addFiles(Array.from(e.dataTransfer.files))
  }, [addFiles])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) {
      setIsDragging(true)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const isActive = state.status !== 'idle' && state.status !== 'error' && state.status !== 'complete'
  const showPinDisplay = pin && state.status === 'waiting_for_receiver'
  const showQRDisplay = activeMethod === 'manual' && offerData && state.status === 'showing_offer'
  const showQRInput = activeMethod === 'manual' && state.status === 'showing_offer'

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          {supportsFolderSelection && (
            <Tabs value={mode} onValueChange={(v) => setMode(v as ContentMode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="file" className="flex items-center gap-2">
                  <FileUp className="h-4 w-4" />
                  Files
                </TabsTrigger>
                <TabsTrigger value="folder" className="flex items-center gap-2">
                  <FolderUp className="h-4 w-4" />
                  Folder
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          {mode === 'file' && (
            <div className="space-y-2">
              {isCompressing ? (
                <div className="min-h-[200px] border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-3 border-muted-foreground/25">
                  <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
                  <p className="font-medium">Compressing to ZIP...</p>
                </div>
              ) : selectedFiles.length > 0 ? (
                <div className="space-y-2">
                  {/* File list */}
                  <div className="max-h-[160px] overflow-y-auto space-y-1 border rounded-lg p-2">
                    {selectedFiles.map((file, index) => (
                      <div key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 group">
                        <FileUp className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <span className="flex-1 truncate text-sm">{file.name}</span>
                        <span className="text-xs text-muted-foreground flex-shrink-0">{formatFileSize(file.size)}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => removeFile(index)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  {/* Summary and add more */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} • {formatFileSize(filesTotalSize)}
                      {selectedFiles.length > 1 && ' • Will compress to ZIP'}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Add more
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragEnter={handleDragEnter}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={`
                    min-h-[200px] border-2 border-dashed rounded-lg
                    flex flex-col items-center justify-center gap-3
                    cursor-pointer transition-colors
                    ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'}
                  `}
                >
                  <Upload className="h-10 w-10 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium">Drop files here or click to select</p>
                    <p className="text-sm text-muted-foreground">
                      Max size: {formatFileSize(MAX_MESSAGE_SIZE)}
                    </p>
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileInputChange}
                className="hidden"
              />
              {isFilesOverLimit && (
                <p className="text-xs text-destructive">
                  Total size exceeds {formatFileSize(MAX_MESSAGE_SIZE)} limit
                </p>
              )}
            </div>
          )}

          {mode === 'folder' && (
            <div className="space-y-2">
              <div
                onClick={() => folderInputRef.current?.click()}
                className={`
                  min-h-[200px] border-2 border-dashed rounded-lg
                  flex flex-col items-center justify-center gap-3
                  cursor-pointer transition-colors
                  border-muted-foreground/25 hover:border-muted-foreground/50
                  ${folderFiles ? 'bg-muted/50' : ''}
                `}
              >
                {isCompressing ? (
                  <>
                    <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
                    <div className="text-center">
                      <p className="font-medium">Compressing to ZIP...</p>
                    </div>
                  </>
                ) : folderFiles ? (
                  <>
                    <FolderUp className="h-10 w-10 text-muted-foreground" />
                    <div className="text-center">
                      <p className="font-medium truncate max-w-[250px]">
                        {getFolderName(folderFiles)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {folderFiles.length} file{folderFiles.length !== 1 ? 's' : ''} &bull; {formatFileSize(folderTotalSize)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        setFolderFiles(null)
                        if (folderInputRef.current) folderInputRef.current.value = ''
                      }}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  </>
                ) : (
                  <>
                    <FolderUp className="h-10 w-10 text-muted-foreground" />
                    <div className="text-center">
                      <p className="font-medium">Click to select a folder</p>
                      <p className="text-sm text-muted-foreground">
                        Will be compressed to ZIP &bull; Max: {formatFileSize(MAX_MESSAGE_SIZE)}
                      </p>
                    </div>
                  </>
                )}
              </div>
              <input
                ref={folderInputRef}
                type="file"
                onChange={handleFolderInputChange}
                className="hidden"
                webkitdirectory=""
                directory=""
              />
              {isFolderOverLimit && (
                <p className="text-xs text-destructive">
                  Total size exceeds {formatFileSize(MAX_MESSAGE_SIZE)} limit
                </p>
              )}
            </div>
          )}

          {/* How it works info box */}
          <div className="rounded-lg bg-gradient-to-br from-primary/5 to-accent/5 border border-primary/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2">
                <Info className="h-4 w-4 text-primary" />
              </div>
              <div className="text-sm">
                <p className="font-medium mb-1">How it works</p>
                <p className="text-muted-foreground">
                  Your files are encrypted on your device before sending. Share a PIN with your recipient—only they can decrypt and receive your files.
                </p>
              </div>
            </div>
          </div>

          {/* Advanced Options */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center gap-2 p-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Advanced Options
              {methodChoice !== 'nostr' && (
                <span className="ml-auto text-xs bg-muted px-2 py-0.5 rounded">
                  Manual
                </span>
              )}
            </button>
            {showAdvanced && (
              <div className="p-3 pt-0 space-y-2 border-t">
                <Label className="text-sm font-medium">Signaling Method</Label>
                <RadioGroup
                  value={methodChoice}
                  onValueChange={(v) => {
                    const nextMethod = v as MethodChoice
                    setMethodChoice(nextMethod)
                    if (nextMethod === 'manual') {
                      setRelayOnly(false)
                    }
                  }}
                  className="flex flex-wrap gap-4"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="nostr" id="nostr" />
                    <Label htmlFor="nostr" className="text-sm font-normal cursor-pointer">
                      Nostr
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="manual" id="manual" />
                    <Label htmlFor="manual" className="text-sm font-normal cursor-pointer flex items-center gap-1">
                      <QrCode className="h-3 w-3" />
                      Manual
                    </Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  {methodChoice === 'nostr'
                    ? 'Uses Nostr relays for signaling. Requires internet.'
                    : 'Manual exchange via QR scan or copy/paste. No internet required. Without internet, devices must be on same local network.'}
                </p>
                {methodChoice === 'nostr' && (
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      id="force-cloud-transfer"
                      type="checkbox"
                      className="h-4 w-4"
                      checked={relayOnly}
                      onChange={(e) => setRelayOnly(e.target.checked)}
                    />
                    <Label htmlFor="force-cloud-transfer" className="text-sm font-normal cursor-pointer">
                      Force cloud transfer (skip P2P)
                    </Label>
                  </div>
                )}

                {/* Passkey toggle - only for Nostr */}
                {methodChoice === 'nostr' && (
                  <div className="pt-3 border-t space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Fingerprint className="h-4 w-4 text-muted-foreground" />
                        <Label htmlFor="use-passkey" className="text-sm font-medium cursor-pointer">
                          Use Passkey Mode
                        </Label>
                      </div>
                      <Switch
                        id="use-passkey"
                        checked={usePasskey}
                        onCheckedChange={setUsePasskey}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {usePasskey
                        ? 'Send to a specific recipient using their public ID. No PIN needed.'
                        : 'Use passkey-based encryption instead of PIN. Requires receiver\'s public ID.'}
                    </p>
                    {!usePasskey && (
                      <p className="text-xs text-muted-foreground">
                        Use the{' '}
                        <Link to="/passkey" className="text-primary hover:underline">
                          Passkey setup page
                        </Link>{' '}
                        to create, manage your passkey or get your passkey&apos;s public ID.
                      </p>
                    )}

                    {/* Receiver public ID input - only shown when passkey enabled */}
                    {usePasskey && (
                      <div className="space-y-3 pt-2 border-t border-dashed">
                        {/* Send to self checkbox */}
                        <div className="flex items-center gap-2">
                          <input
                            id="send-to-self"
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300"
                            checked={sendToSelf}
                            onChange={(e) => setSendToSelf(e.target.checked)}
                          />
                          <Label htmlFor="send-to-self" className="text-sm font-normal cursor-pointer">
                            Send to myself
                          </Label>
                        </div>
                        {sendToSelf && (
                          <p className="text-xs text-muted-foreground">
                            Transfer files to yourself using the same passkey on another device.
                          </p>
                        )}

                        {/* Pairing key input - hidden when sending to self */}
                        {!sendToSelf && (
                          <>
                            <Label htmlFor="receiver-pubkey" className="text-sm font-medium">
                              Pairing Key
                            </Label>
                            {/* Saved pairing keys dropdown */}
                            {savedPairingKeys.length > 0 && (
                              <div className="relative">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-full justify-between text-xs"
                                  onClick={() => setShowPairingKeyDropdown(!showPairingKeyDropdown)}
                                >
                                  <span className="text-muted-foreground">Select from saved pairing keys ({savedPairingKeys.length})</span>
                                  <ChevronDown className={`h-3 w-3 transition-transform ${showPairingKeyDropdown ? 'rotate-180' : ''}`} />
                                </Button>
                                {showPairingKeyDropdown && (
                                  <div className="absolute z-10 w-full mt-1 bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                                    {savedPairingKeys.map((saved, index) => (
                                      <button
                                        key={index}
                                        className="w-full px-3 py-2 text-left hover:bg-muted/50 border-b last:border-b-0 text-xs"
                                        onClick={() => {
                                          setReceiverPublicKeyInput(saved.pairingKey)
                                          setLoadedFromHistory(true)
                                          setShowPairingKeyDropdown(false)
                                        }}
                                      >
                                        <div className="flex items-center gap-2">
                                          <Fingerprint className="h-3 w-3 text-muted-foreground" />
                                          <span className="font-mono">{formatFingerprint(saved.partyAFingerprint)}</span>
                                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                          <span className="font-mono">{formatFingerprint(saved.partyBFingerprint)}</span>
                                        </div>
                                        {saved.comment && (
                                          <div className="text-muted-foreground mt-0.5 truncate">{saved.comment}</div>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                            {/* Hide textarea when pairing key is loaded from history and parsed */}
                            {!(loadedFromHistory && parsedPairingKey) && (
                              <div className="flex gap-2">
                                <Textarea
                                  id="receiver-pubkey"
                                  placeholder="Paste pairing key from your Passkey page..."
                                  value={receiverPublicKeyInput}
                                  onChange={(e) => {
                                    setReceiverPublicKeyInput(e.target.value)
                                    setLoadedFromHistory(false)
                                  }}
                                  className="font-mono text-xs min-h-[60px] resize-none"
                                />
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setShowPairingKeyQRScanner(true)}
                                  className="flex-shrink-0"
                                  title="Scan pairing key QR code"
                                >
                                  <Camera className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                            {/* Show entry options when pairing key is loaded from history */}
                            {loadedFromHistory && parsedPairingKey && (
                              <div className="flex gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => {
                                    setReceiverPublicKeyInput('')
                                    setParsedPairingKey(null)
                                    setLoadedFromHistory(false)
                                  }}
                                >
                                  <Keyboard className="h-3 w-3 mr-1" />
                                  Enter manually
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => setShowPairingKeyQRScanner(true)}
                                >
                                  <Camera className="h-3 w-3 mr-1" />
                                  Scan QR
                                </Button>
                              </div>
                            )}
                            {receiverPublicKeyError && (
                              <p className="text-xs text-destructive">{receiverPublicKeyError}</p>
                            )}
                            {parsedPairingKey && (
                              <div className="space-y-1 text-xs">
                                <div className="flex items-center gap-1 text-amber-600 dark:text-amber-500 mb-1">
                                  <span className="text-[10px]">⚠ Unverified fingerprints (will be verified via handshake proof)</span>
                                </div>
                                <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400">
                                  <Fingerprint className="h-3 w-3" />
                                  <span>Party A:</span>
                                  <span className="font-mono font-medium">{formatFingerprint(parsedPairingKey.partyAFingerprint)}</span>
                                </div>
                                <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400 ml-5">
                                  <span>Party B:</span>
                                  <span className="font-mono font-medium">{formatFingerprint(parsedPairingKey.partyBFingerprint)}</span>
                                </div>
                                {parsedPairingKey.comment && (
                                  <div className="flex items-center gap-2 text-muted-foreground ml-5">
                                    <span className="italic">"{parsedPairingKey.comment}"</span>
                                  </div>
                                )}
                                <div className="flex items-center gap-2 ml-5">
                                  <Link to="/passkey/verify-token" className="text-primary hover:underline text-xs">
                                    Verify your signature →
                                  </Link>
                                </div>
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                              Create and exchange a pairing key on your{' '}
                              <Link to="/passkey" className="text-primary hover:underline">
                                Passkey page
                              </Link>{' '}
                              with your peer
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {relayOnly && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded">
              <Cloud className="h-3 w-3" />
              <span>Cloud-only mode</span>
            </div>
          )}

          {usePasskey && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-primary/10 border border-primary/20 px-3 py-2 rounded">
              <Fingerprint className="h-3 w-3" />
              <span>
                Passkey mode{sendToSelf ? ' → sending to self' : parsedPairingKey ? ' → pairing key loaded' : ' (enter pairing key)'}
              </span>
            </div>
          )}

          {/* Pairing Key QR Scanner Modal */}
          {showPairingKeyQRScanner && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
              <div className="bg-background rounded-lg p-4 max-w-sm w-full mx-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium flex items-center gap-2">
                    <Camera className="h-5 w-5" />
                    Scan Pairing Key QR Code
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowPairingKeyQRScanner(false)
                      setPairingKeyQRError(null)
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="relative bg-black rounded-lg overflow-hidden aspect-square">
                  {pairingKeyQRError && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
                      <div className="text-center p-4">
                        <p className="text-red-400 text-sm mb-2">{pairingKeyQRError}</p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPairingKeyQRError(null)}
                        >
                          <RefreshCw className="h-4 w-4 mr-1" />
                          Retry
                        </Button>
                      </div>
                    </div>
                  )}
                  <video
                    ref={pairingKeyVideoRef}
                    className="w-full h-full object-cover"
                    autoPlay
                    playsInline
                    muted
                  />
                  <canvas ref={pairingKeyCanvasRef} className="hidden" />
                  {!pairingKeyCameraReady && !pairingKeyQRError && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin text-white" />
                    </div>
                  )}
                </div>

                {pairingKeyAvailableCameras.length > 1 && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={selectedPairingKeyCamera === 'environment' ? 'default' : 'outline'}
                      onClick={() => setSelectedPairingKeyCamera('environment')}
                      className="flex-1"
                    >
                      Back Camera
                    </Button>
                    <Button
                      size="sm"
                      variant={selectedPairingKeyCamera === 'user' ? 'default' : 'outline'}
                      onClick={() => setSelectedPairingKeyCamera('user')}
                      className="flex-1"
                    >
                      Front Camera
                    </Button>
                  </div>
                )}

                <p className="text-xs text-muted-foreground text-center">
                  Point camera at the pairing key QR code
                </p>
              </div>
            </div>
          )}

          {checkingNostr && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Checking Nostr relay availability...</span>
            </div>
          )}

          {nostrUnavailable ? (
            <div className="space-y-3 p-4 border border-amber-500/50 bg-amber-500/10 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium text-sm">Nostr Relays Unavailable</p>
                  <p className="text-xs text-muted-foreground">
                    Nostr relays are unreachable. You can switch to Manual mode which doesn't require internet - exchange signaling via QR code or copy/paste.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSwitchToManual} className="flex-1" size="sm">
                  <QrCode className="mr-2 h-4 w-4" />
                  Switch to Manual
                </Button>
                <Button onClick={handleRetryNostr} variant="outline" size="sm">
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => handleSend()} disabled={!canSend || checkingNostr} className="w-full">
              <Send className="mr-2 h-4 w-4" />
              {methodChoice === 'manual' ? 'Generate & Send' : 'Generate Secure PIN'}
              <ChevronRight className="ml-1 h-3 w-3" />
            </Button>
          )}
        </>
      ) : (
        <>
          {/* Show active method indicator */}
          {activeMethod && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded">
              {activeMethod === 'nostr' ? (
                <>
                  <Cloud className="h-3 w-3" />
                  <span>
                    {relayOnly ? 'Using Nostr with Cloud Transfer Only' : 'Using Nostr'}
                  </span>
                </>
              ) : (
                <>
                  <QrCode className="h-3 w-3" />
                  <span>Using Manual</span>
                </>
              )}
            </div>
          )}

          <TransferStatus
            state={state}
            betweenProgressAndChunks={showPinDisplay ? <PinDisplay pin={pin} passkeyFingerprint={null} onExpire={cancel} /> : undefined}
          />

          {/* Sender fingerprint display in passkey mode */}
          {activeMethod === 'nostr' && senderFingerprint && (
            <div className="text-xs text-muted-foreground border border-cyan-500/30 bg-cyan-50/30 dark:bg-cyan-950/20 px-3 py-2 rounded">
              <div className="flex items-center gap-2 font-mono">
                <Fingerprint className="h-3 w-3 text-cyan-600" />
                <span>Your fingerprint: </span>
                <span className="font-medium text-cyan-600">
                  {formatFingerprint(senderFingerprint)}
                </span>
              </div>
              <p className="mt-1 ml-5">Receiver should verify this matches your public ID.</p>
            </div>
          )}

          {/* Passkey authentication help */}
          {state.status === 'connecting' && state.message?.toLowerCase().includes('passkey') && (
            <div className="text-xs text-muted-foreground border border-primary/20 bg-primary/5 px-3 py-2 rounded space-y-1">
              <p>A passkey prompt should appear from your browser or password manager.</p>
              <p>
                Don't have a passkey yet?{' '}
                <Link to="/passkey" className="text-primary hover:underline inline-flex items-center gap-1">
                  Create one here <ArrowRight className="h-3 w-3" />
                </Link>
              </p>
            </div>
          )}

          {/* QR Code display for sender */}
          {showQRDisplay && (
            <QRDisplay
              data={offerData!}
              clipboardData={clipboardData}
              label="Show this QR to receiver"
            />
          )}

          {/* QR Input for receiving answer */}
          {showQRInput && submitAnswer && (
            <div className="border-t pt-4">
              <QRInput
                expectedType="answer"
                label="Paste receiver's response QR data"
                onSubmit={submitAnswer}
              />
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
                Send Another
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
