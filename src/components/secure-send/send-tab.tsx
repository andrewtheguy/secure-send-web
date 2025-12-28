import { useState, useRef, useCallback } from 'react'
import { Send, X, RotateCcw, FileUp, Upload, Cloud, FolderUp, Loader2, ChevronDown, ChevronRight, QrCode, AlertTriangle, Info, Fingerprint } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
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

type ContentMode = 'file' | 'folder'
type ForcedMethod = 'nostr-only' | 'manual-only'

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
  const [forcedMethod, setForcedMethod] = useState<ForcedMethod | null>(null)
  const [usePasskey, setUsePasskey] = useState(false)
  const [activeMethod, setActiveMethod] = useState<SignalingMethod | null>(null)
  const [detectingMethod, setDetectingMethod] = useState(false)
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [folderFiles, setFolderFiles] = useState<FileList | null>(null) // Keep FileList for folder to preserve paths
  const [isCompressing, setIsCompressing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [signalingUnavailable, setSignalingUnavailable] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  // All hooks must be called unconditionally (React rules)
  const nostrHook = useNostrSend()
  const manualHook = useManualSend()

  // Use the appropriate hook based on active method (defaults to nostr before detection)
  const activeHook = activeMethod === 'manual' ? manualHook : nostrHook

  // Only nostr and peerjs hooks have PIN - use runtime check for type safety
  const pin: string | null =
    activeMethod !== 'manual' && 'pin' in activeHook && typeof activeHook.pin === 'string'
      ? activeHook.pin
      : null
  // Only nostr hook has passkeyFingerprint for dual mode
  const passkeyFingerprint: string | null =
    activeMethod === 'nostr' && 'passkeyFingerprint' in activeHook && typeof activeHook.passkeyFingerprint === 'string'
      ? activeHook.passkeyFingerprint
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

  const filesTotalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)
  const folderTotalSize = folderFiles ? getTotalSize(folderFiles) : 0
  const isFilesOverLimit = filesTotalSize > MAX_MESSAGE_SIZE
  const isFolderOverLimit = folderTotalSize > MAX_MESSAGE_SIZE

  const canSendFiles = selectedFiles.length > 0 && !isFilesOverLimit && state.status === 'idle' && !isCompressing
  const canSendFolder = folderFiles && folderFiles.length > 0 && !isFolderOverLimit && state.status === 'idle' && !isCompressing
  const canSend = mode === 'file' ? canSendFiles : canSendFolder

  const handleSend = async (overrideMethod?: ForcedMethod) => {
    // Determine which method to use
    let methodToUse: SignalingMethod
    const effectiveMethod = overrideMethod ?? forcedMethod

    if (effectiveMethod) {
      // User forced a specific method via advanced options
      methodToUse = effectiveMethod.replace('-only', '') as SignalingMethod
    } else {
      // Smart mode: test Nostr relay availability
      setDetectingMethod(true)
      setSignalingUnavailable(false)
      try {
        const { testRelayAvailability } = await import('@/lib/nostr')
        const nostrResult = await testRelayAvailability()

        if (nostrResult.available) {
          methodToUse = 'nostr'
          console.log('Smart detection: Nostr available', nostrResult)
        } else {
          // Nostr unavailable - prompt user for manual mode
          console.log('Smart detection: Nostr unavailable', nostrResult)
          setDetectingMethod(false)
          setSignalingUnavailable(true)
          return // Don't auto-fallback to QR, let user decide
        }
      } catch (error) {
        // If test fails completely, show unavailable prompt
        console.error('Signaling availability test failed:', error)
        setDetectingMethod(false)
        setSignalingUnavailable(true)
        return
      }
      setDetectingMethod(false)
    }

    setActiveMethod(methodToUse)

    // Only Nostr hook supports relayOnly and usePasskey options
    const sendOptions = methodToUse === 'nostr' ? { relayOnly, usePasskey } : undefined

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
    setSignalingUnavailable(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (folderInputRef.current) folderInputRef.current.value = ''
  }

  const handleUseManualExchange = () => {
    setSignalingUnavailable(false)
    setForcedMethod('manual-only')
    // Pass method directly to avoid state timing issues
    handleSend('manual-only')
  }

  const handleRetrySignaling = () => {
    setSignalingUnavailable(false)
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
              {forcedMethod && (
                <span className="ml-auto text-xs bg-muted px-2 py-0.5 rounded">
                  {forcedMethod === 'nostr-only' ? 'Nostr only' : 'Manual'}
                </span>
              )}
            </button>
            {showAdvanced && (
              <div className="p-3 pt-0 space-y-2 border-t">
                <Label className="text-sm font-medium">Force Signaling Method</Label>
                <RadioGroup
                  value={forcedMethod || 'auto'}
                  onValueChange={(v) => {
                    const nextMethod = v === 'auto' ? null : v as ForcedMethod
                    setForcedMethod(nextMethod)
                    if (nextMethod !== 'nostr-only') {
                      setRelayOnly(false)
                    }
                  }}
                  className="flex flex-wrap gap-4"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="auto" id="auto" />
                    <Label htmlFor="auto" className="text-sm font-normal cursor-pointer">
                      Auto (Smart)
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="nostr-only" id="nostr-only" />
                    <Label htmlFor="nostr-only" className="text-sm font-normal cursor-pointer">
                      Nostr only
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="manual-only" id="manual-only" />
                    <Label htmlFor="manual-only" className="text-sm font-normal cursor-pointer flex items-center gap-1">
                      <QrCode className="h-3 w-3" />
                      Manual
                    </Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  {forcedMethod === null
                    ? 'Auto mode tests Nostr relay availability before sending.'
                    : forcedMethod === 'nostr-only'
                      ? 'Force Nostr relays. Transfer fails if relays are unavailable.'
                      : 'Manual exchange via QR scan or copy/paste. No internet required. Without internet, devices must be on same local network.'}
                </p>
                {forcedMethod === 'nostr-only' && (
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
                {(forcedMethod === null || forcedMethod === 'nostr-only') && (
                  <div className="pt-3 border-t">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Fingerprint className="h-4 w-4 text-muted-foreground" />
                        <Label htmlFor="use-passkey" className="text-sm font-medium cursor-pointer">
                          Use Passkey instead of PIN
                        </Label>
                      </div>
                      <Switch
                        id="use-passkey"
                        checked={usePasskey}
                        onCheckedChange={setUsePasskey}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {usePasskey
                        ? 'Receiver must have the same synced passkey (1Password, iCloud, Google).'
                        : 'Use your passkey for encryption instead of a PIN. Great for personal cross-device transfers.'}
                    </p>
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
              <span>Passkey mode enabled</span>
            </div>
          )}

          {detectingMethod && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Testing signaling servers...</span>
            </div>
          )}

          {signalingUnavailable ? (
            <div className="space-y-3 p-4 border border-amber-500/50 bg-amber-500/10 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium text-sm">Signaling Servers Unavailable</p>
                  <p className="text-xs text-muted-foreground">
                    Nostr relays are unreachable. You can use Manual Exchange mode which doesn't require internet - exchange signaling via QR code or copy/paste.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleUseManualExchange} disabled={!canSend} className="flex-1" size="sm">
                  <QrCode className="mr-2 h-4 w-4" />
                  Use Manual Exchange
                </Button>
                <Button onClick={handleRetrySignaling} variant="outline" size="sm">
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => handleSend()} disabled={!canSend || detectingMethod} className="w-full">
              <Send className="mr-2 h-4 w-4" />
              {forcedMethod === 'manual-only' ? 'Generate & Send' : 'Generate Secure PIN'}
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
                    {relayOnly
                      ? 'Using Nostr with Cloud Transfer Only (forced)'
                      : `Using Nostr${forcedMethod ? ' (forced)' : ' (auto-detected)'}`}
                  </span>
                </>
              ) : (
                <>
                  <QrCode className="h-3 w-3" />
                  <span>Using Manual{forcedMethod ? ' (forced)' : ''}</span>
                </>
              )}
            </div>
          )}

          <TransferStatus
            state={state}
            betweenProgressAndChunks={showPinDisplay ? <PinDisplay pin={pin} passkeyFingerprint={passkeyFingerprint} onExpire={cancel} /> : undefined}
          />

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
