import { useState, useRef, useCallback } from 'react'
import { Send, X, FileUp, Upload, FolderUp, ChevronDown, ChevronRight, Info, Fingerprint, Cloud, KeyRound, QrCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { MAX_MESSAGE_SIZE } from '@/lib/crypto'
import { formatFileSize } from '@/lib/file-utils'
import { getTotalSize, supportsFolderSelection, getFolderName } from '@/lib/folder-utils'
import { Link, useNavigate } from 'react-router-dom'
import { useSend } from '@/contexts/send-context'

type ContentMode = 'file' | 'folder'
type MethodChoice = 'online' | 'offline'

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
  const [methodChoice, setMethodChoice] = useState<MethodChoice>('online')
  const [usePasskey, setUsePasskey] = useState(false)
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [folderFiles, setFolderFiles] = useState<FileList | null>(null) // Keep FileList for folder to preserve paths
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  const filesTotalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)
  const folderTotalSize = folderFiles ? getTotalSize(folderFiles) : 0
  const isFilesOverLimit = filesTotalSize > MAX_MESSAGE_SIZE
  const isFolderOverLimit = folderTotalSize > MAX_MESSAGE_SIZE

  const canSendFiles = selectedFiles.length > 0 && !isFilesOverLimit
  const canSendFolder = folderFiles && folderFiles.length > 0 && !isFolderOverLimit
  const canSend = mode === 'file' ? canSendFiles : canSendFolder
  const pinModeDescription = 'Most reliable option. Requires manual PIN entry and relay coordination; data stays end-to-end encrypted.'
  const pinModeHowItWorksDescription = 'More reliable option, but requires manual PIN input. Coordination happens through third-party relay servers. No personally identifiable information is shared, and your data remains protected with end-to-end encryption.'
  const qrModeDescription = 'Coordination happens through QR exchange. No third-party coordination servers; STUN may be used when internet is available. Data stays end-to-end encrypted.'
  const qrModeHowItWorksDescription = 'Coordination happens through QR exchange. If internet is available, STUN is only used for connection setup metadata (such as IP address and port). STUN does not receive your file contents, encryption keys, or any personally identifiable information. Without internet, no third-party servers are involved. Data stays end-to-end encrypted.'

  const handleSend = () => {
    // Set context with all the configuration
    setConfig({
      selectedFiles,
      folderFiles,
      methodChoice,
      usePasskey,
      relayOnly,
    })
    // Navigate to transfer page
    void navigate('/send/transfer')
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

          {/* Transfer mode selector */}
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium">Transfer mode</p>
            <RadioGroup
              value={methodChoice}
              onValueChange={(value) => {
                setMethodChoice(value as MethodChoice)
                if (value === 'offline') {
                  setRelayOnly(false)
                  setUsePasskey(false)
                  setShowAdvanced(false)
                }
              }}
              className="gap-2"
            >
              <label
                htmlFor="send-mode-pin"
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                  methodChoice === 'online'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/60'
                }`}
              >
                <RadioGroupItem id="send-mode-pin" value="online" className="mt-0.5" />
                <div className="space-y-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <KeyRound className="h-4 w-4" />
                    PIN mode
                  </span>
                  <p className="text-xs text-muted-foreground">{pinModeDescription}</p>
                </div>
              </label>

              <label
                htmlFor="send-mode-qr"
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                  methodChoice === 'offline'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/60'
                }`}
              >
                <RadioGroupItem id="send-mode-qr" value="offline" className="mt-0.5" />
                <div className="space-y-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <QrCode className="h-4 w-4" />
                    QR code mode
                  </span>
                  <p className="text-xs text-muted-foreground">{qrModeDescription}</p>
                </div>
              </label>
            </RadioGroup>
          </div>

          {/* How it works info box */}
          <div className="rounded-lg bg-gradient-to-br from-primary/5 to-accent/5 border border-primary/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2">
                <Info className="h-4 w-4 text-primary" />
              </div>
              <div className="text-sm">
                <p className="font-medium mb-1">How it works</p>
                <p className="text-muted-foreground">
                  {methodChoice === 'online'
                    ? <>Share your PIN with the recipient so they can connect and decrypt your files.<br />{pinModeHowItWorksDescription}</>
                    : <>Exchange QR codes with your recipient to establish the transfer session.<br />{qrModeHowItWorksDescription}</>}
                </p>
              </div>
            </div>
          </div>

          {/* Advanced Options (PIN mode only) */}
          {methodChoice === 'online' && (
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
                  <p className="text-xs text-muted-foreground">
                    {`PIN mode: ${pinModeDescription}`}
                  </p>

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
                        ? 'Send files to yourself across devices using your passkey. No PIN needed.'
                        : 'Use passkey-based encryption for self-transfer across your devices.'}
                    </p>
                    {!usePasskey && (
                      <p className="text-xs text-muted-foreground">
                        Use the{' '}
                        <Link to="/passkey" className="text-primary hover:underline">
                          Passkey setup page
                        </Link>{' '}
                        to create your passkey.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {relayOnly && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded">
              <Cloud className="h-3 w-3" />
              <span>Cloud-only mode</span>
            </div>
          )}

          {usePasskey && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-primary/10 border border-primary/20 px-3 py-2 rounded">
              <Fingerprint className="h-3 w-3" />
              <span>Passkey mode — self-transfer</span>
            </div>
          )}

          <Button onClick={handleSend} disabled={!canSend} className="w-full">
            <Send className="mr-2 h-4 w-4" />
            {methodChoice === 'offline' ? 'Start QR Code Transfer' : 'Generate Secure PIN'}
            <ChevronRight className="ml-1 h-3 w-3" />
          </Button>
    </div>
  )
}
