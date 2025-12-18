import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, X, RotateCcw, FileUp, FileText, Upload, Cloud, FolderUp, Loader2, ChevronDown, ChevronRight, QrCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { PinDisplay } from './pin-display'
import { TransferStatus } from './transfer-status'
import { QRDisplay } from './qr-display'
import { QRInput } from './qr-input'
import { useNostrSend } from '@/hooks/use-nostr-send'
import { usePeerJSSend } from '@/hooks/use-peerjs-send'
import { useQRSend } from '@/hooks/use-qr-send'
import { MAX_MESSAGE_SIZE } from '@/lib/crypto'
import { formatFileSize } from '@/lib/file-utils'
import { setCloudServer } from '@/lib/cloud-storage'
import { compressFilesToZip, getFolderName, getTotalSize, supportsFolderSelection } from '@/lib/folder-utils'
import type { SignalingMethod } from '@/lib/nostr/types'

type ContentMode = 'text' | 'file' | 'folder'

// Declare global for TypeScript
declare global {
  interface Window {
    testCloudTransfer?: (enable: boolean, server?: string | null) => void
  }
}

// Extend input element to include webkitdirectory attribute
declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
    directory?: string
  }
}

export function SendTab() {
  const [mode, setMode] = useState<ContentMode>('file')
  const [message, setMessage] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [signalingMethod, setSignalingMethod] = useState<SignalingMethod>('nostr')
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedServer, setSelectedServer] = useState<string | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [folderFiles, setFolderFiles] = useState<FileList | null>(null) // Keep FileList for folder to preserve paths
  const [isCompressing, setIsCompressing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  // All hooks must be called unconditionally (React rules)
  const nostrHook = useNostrSend()
  const peerJSHook = usePeerJSSend()
  const qrHook = useQRSend()

  // Use the appropriate hook based on signaling method
  const activeHook = signalingMethod === 'nostr' ? nostrHook : signalingMethod === 'peerjs' ? peerJSHook : qrHook
  const { state: rawState, pin, send, cancel } = activeHook
  const submitAnswer = signalingMethod === 'qr' ? qrHook.submitAnswer : undefined

  // Normalize state for QR hook (it has additional status values)
  const state = rawState as typeof nostrHook.state & { offerQRData?: string }

  // Expose console function to enable/disable cloud-only mode for testing
  useEffect(() => {
    window.testCloudTransfer = (enable: boolean, server?: string | null) => {
      setRelayOnly(enable)
      if (enable && server !== undefined) {
        setCloudServer(server)
        setSelectedServer(server)
      } else if (!enable) {
        setSelectedServer(null)
      }
      console.log(`Cloud-only transfer mode ${enable ? 'enabled' : 'disabled'}${enable && server ? ` (server: ${server})` : ''}`)
    }
    return () => {
      delete window.testCloudTransfer
    }
  }, [])

  const encoder = new TextEncoder()
  const messageSize = encoder.encode(message).length
  const isTextOverLimit = messageSize > MAX_MESSAGE_SIZE
  const filesTotalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)
  const folderTotalSize = folderFiles ? getTotalSize(folderFiles) : 0
  const isFilesOverLimit = filesTotalSize > MAX_MESSAGE_SIZE
  const isFolderOverLimit = folderTotalSize > MAX_MESSAGE_SIZE

  const canSendText = message.trim().length > 0 && !isTextOverLimit && state.status === 'idle'
  const canSendFiles = selectedFiles.length > 0 && !isFilesOverLimit && state.status === 'idle' && !isCompressing
  const canSendFolder = folderFiles && folderFiles.length > 0 && !isFolderOverLimit && state.status === 'idle' && !isCompressing
  const canSend = mode === 'text' ? canSendText : mode === 'file' ? canSendFiles : canSendFolder

  const handleSend = async () => {
    // Only Nostr hook supports relayOnly option
    const sendOptions = signalingMethod === 'nostr' ? { relayOnly } : undefined

    const doSend = (content: string | File) => {
      if (signalingMethod === 'nostr') {
        (send as typeof nostrHook.send)(content, sendOptions)
      } else {
        // PeerJS and QR hooks have same signature
        (send as typeof peerJSHook.send)(content)
      }
    }

    if (mode === 'text' && canSendText) {
      doSend(message)
    } else if (mode === 'file' && canSendFiles) {
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
    cancel()
    setMessage('')
    setSelectedFiles([])
    setFolderFiles(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (folderInputRef.current) folderInputRef.current.value = ''
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
  const showQRDisplay = signalingMethod === 'qr' && state.offerQRData && (state.status === 'showing_offer_qr' || state.status === 'waiting_for_receiver')
  const showQRInput = signalingMethod === 'qr' && state.status === 'showing_offer_qr'

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <Tabs value={mode} onValueChange={(v) => setMode(v as ContentMode)}>
            <TabsList className={`grid w-full ${supportsFolderSelection ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <TabsTrigger value="file" className="flex items-center gap-2">
                <FileUp className="h-4 w-4" />
                Files
              </TabsTrigger>
              {supportsFolderSelection && (
                <TabsTrigger value="folder" className="flex items-center gap-2">
                  <FolderUp className="h-4 w-4" />
                  Folder
                </TabsTrigger>
              )}
              <TabsTrigger value="text" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Text
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === 'text' && (
            <div className="space-y-2">
              <Textarea
                placeholder="Enter your message here..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="min-h-[200px] font-mono"
                disabled={isActive}
              />
              <div className="flex justify-between text-xs">
                <span className={isTextOverLimit ? 'text-destructive' : 'text-muted-foreground'}>
                  {formatFileSize(messageSize)} / {formatFileSize(MAX_MESSAGE_SIZE)}
                </span>
                {isTextOverLimit && <span className="text-destructive">Message too large</span>}
              </div>
            </div>
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

          {/* Advanced Options */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center gap-2 p-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Advanced Options
            </button>
            {showAdvanced && (
              <div className="p-3 pt-0 space-y-2 border-t">
                <Label className="text-sm font-medium">Signaling Method</Label>
                <RadioGroup
                  value={signalingMethod}
                  onValueChange={(v) => setSignalingMethod(v as SignalingMethod)}
                  className="flex flex-wrap gap-4"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="nostr" id="nostr" />
                    <Label htmlFor="nostr" className="text-sm font-normal cursor-pointer">
                      Nostr (with cloud fallback)
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="peerjs" id="peerjs" />
                    <Label htmlFor="peerjs" className="text-sm font-normal cursor-pointer">
                      PeerJS (P2P only)
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="qr" id="qr" />
                    <Label htmlFor="qr" className="text-sm font-normal cursor-pointer flex items-center gap-1">
                      <QrCode className="h-3 w-3" />
                      QR Code (serverless)
                    </Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  {signalingMethod === 'nostr'
                    ? 'Uses decentralized Nostr relays. Falls back to cloud if P2P fails.'
                    : signalingMethod === 'peerjs'
                    ? 'Uses PeerJS server for simpler P2P. No cloud fallback - transfer fails if P2P unavailable.'
                    : 'Exchange QR codes directly with receiver. No signaling server - truly serverless P2P.'}
                </p>
              </div>
            )}
          </div>

          {relayOnly && signalingMethod === 'nostr' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded">
              <Cloud className="h-3 w-3" />
              <span>Cloud-only mode{selectedServer ? `: ${selectedServer}` : ''}</span>
            </div>
          )}

          <Button onClick={handleSend} disabled={!canSend} className="w-full">
            <Send className="mr-2 h-4 w-4" />
            Generate PIN & Send
          </Button>
        </>
      ) : (
        <>
          <TransferStatus
            state={state}
            betweenProgressAndChunks={showPinDisplay ? <PinDisplay pin={pin} onExpire={cancel} /> : undefined}
          />

          {/* QR Code display for sender */}
          {showQRDisplay && state.offerQRData && (
            <div className="space-y-4">
              <QRDisplay
                data={state.offerQRData}
                label="Show this QR to receiver"
              />
              {pin && (
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">PIN (for receiver)</p>
                  <code className="text-lg font-mono font-bold tracking-wider">{pin}</code>
                </div>
              )}
            </div>
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
