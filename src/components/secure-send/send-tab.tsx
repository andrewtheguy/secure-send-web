import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, X, FileUp, Upload, FolderUp, Loader2, ChevronDown, ChevronRight, Info, Fingerprint, ArrowRight, Keyboard, Camera, RefreshCw, Wifi, WifiOff, Cloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { MAX_MESSAGE_SIZE } from '@/lib/crypto'
import { formatFileSize } from '@/lib/file-utils'
import { getTotalSize, supportsFolderSelection, getFolderName } from '@/lib/folder-utils'
import { Link, useNavigate } from 'react-router-dom'
import { formatFingerprint } from '@/lib/crypto/ecdh'
import { isPairingKeyFormat, parsePairingKey, type ParsedPairingKey } from '@/lib/crypto/pairing-key'
import { getSavedPairingKeys, type SavedPairingKey } from '@/lib/saved-pairing-keys'
import { useQRScanner } from '@/hooks/useQRScanner'
import { isMobileDevice } from '@/lib/utils'
import { useSend } from '@/contexts/send-context'

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
  const navigate = useNavigate()
  const { setConfig } = useSend()

  const [mode, setMode] = useState<ContentMode>('file')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [methodChoice, setMethodChoice] = useState<MethodChoice>('nostr')
  const [usePasskey, setUsePasskey] = useState(false)
  const [sendToSelf, setSendToSelf] = useState(false)
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [folderFiles, setFolderFiles] = useState<FileList | null>(null) // Keep FileList for folder to preserve paths
  const [isDragging, setIsDragging] = useState(false)
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset camera state when scanner closes
      setPairingKeyCameraReady(false)
    }
  }, [showPairingKeyQRScanner])

  // Reset pairingKeyCameraReady when camera selection changes while scanner is open
  useEffect(() => {
    if (showPairingKeyQRScanner) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset camera state when switching cameras
      setPairingKeyCameraReady(false)
    }
  }, [selectedPairingKeyCamera, showPairingKeyQRScanner])

  // Parse pairing key - debounced to reduce parsing on every keystroke
  useEffect(() => {
    let cancelled = false

    const input = receiverPublicKeyInput.trim()
    if (!input) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear validation state when input is empty
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Load data from localStorage when feature enabled
      setSavedPairingKeys(getSavedPairingKeys())
    }
  }, [usePasskey])

  const filesTotalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)
  const folderTotalSize = folderFiles ? getTotalSize(folderFiles) : 0
  const isFilesOverLimit = filesTotalSize > MAX_MESSAGE_SIZE
  const isFolderOverLimit = folderTotalSize > MAX_MESSAGE_SIZE

  const canSendFiles = selectedFiles.length > 0 && !isFilesOverLimit
  const canSendFolder = folderFiles && folderFiles.length > 0 && !isFolderOverLimit
  // When passkey mode is enabled, require valid receiver pairing key OR sendToSelf
  const passkeyRequirementsMet = !usePasskey || sendToSelf || (parsedPairingKey !== null)
  const canSend = (mode === 'file' ? canSendFiles : canSendFolder) && passkeyRequirementsMet

  const handleSend = () => {
    // Set context with all the configuration
    setConfig({
      selectedFiles,
      folderFiles,
      methodChoice,
      usePasskey,
      relayOnly,
      sendToSelf,
      parsedPairingKey,
      receiverPublicKeyInput: receiverPublicKeyInput.trim(),
    })
    // Navigate to transfer page
    navigate('/send/transfer')
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

  return (
    <div className="space-y-4 pt-4">
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
              {selectedFiles.length > 0 ? (
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
                {folderFiles ? (
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

          {/* Work online toggle - visible on main UI */}
          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-full ${methodChoice === 'nostr' ? 'bg-green-100 dark:bg-green-900/30' : 'bg-amber-100 dark:bg-amber-900/30'}`}>
                {methodChoice === 'nostr' ? (
                  <Wifi className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : (
                  <WifiOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                )}
              </div>
              <div>
                <Label htmlFor="work-online" className="text-sm font-medium cursor-pointer">
                  Work online
                </Label>
                <p className="text-xs text-muted-foreground">
                  {methodChoice === 'nostr'
                    ? 'Connected to relay servers. Toggle off for offline QR exchange.'
                    : 'Offline mode: Uses QR codes. Both devices must be connected to the same network.'}
                </p>
              </div>
            </div>
            <Switch
              id="work-online"
              checked={methodChoice === 'nostr'}
              onCheckedChange={(checked) => {
                setMethodChoice(checked ? 'nostr' : 'manual')
                if (!checked) setRelayOnly(false)
              }}
            />
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
              {usePasskey && (
                <span className="ml-auto text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
                  Passkey
                </span>
              )}
            </button>
            {showAdvanced && (
              <div className="p-3 pt-0 space-y-3 border-t">
                {/* Technical details about current mode */}
                <p className="text-xs text-muted-foreground">
                  {methodChoice === 'nostr'
                    ? 'Online mode: Uses Nostr relays for signaling. If P2P fails, encrypted data transfers via cloud.'
                    : 'Offline mode: Exchange signaling via QR scan or copy/paste. Devices must be on same local network.'}
                </p>

                {/* Force cloud transfer - only for online mode */}
                {methodChoice === 'nostr' && (
                  <div className="flex items-center gap-2">
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

                {/* Passkey toggle - only for online mode (Nostr) */}
                {methodChoice === 'nostr' && (
                  <div className="pt-3 border-t space-y-3">
                    <div className="flex items-center gap-1 mb-2">
                      <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded">
                        Power User
                      </span>
                    </div>
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
                                    {savedPairingKeys.map((saved) => (
                                      <button
                                        key={saved.pairingKey}
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
                                  <Link to="/passkey/verify" className="text-primary hover:underline text-xs">
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

          <Button onClick={handleSend} disabled={!canSend} className="w-full">
            <Send className="mr-2 h-4 w-4" />
            {methodChoice === 'manual' ? 'Generate & Send' : 'Generate Secure PIN'}
            <ChevronRight className="ml-1 h-3 w-3" />
          </Button>
    </div>
  )
}
