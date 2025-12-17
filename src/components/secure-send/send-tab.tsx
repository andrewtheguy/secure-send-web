import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, X, RotateCcw, FileUp, FileText, Upload, Cloud, FolderUp, Files, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PinDisplay } from './pin-display'
import { TransferStatus } from './transfer-status'
import { useNostrSend } from '@/hooks/use-nostr-send'
import { MAX_MESSAGE_SIZE } from '@/lib/crypto'
import { formatFileSize } from '@/lib/file-utils'
import { setCloudServer } from '@/lib/cloud-storage'
import { compressFilesToZip, getFolderName, getTotalSize, supportsFolderSelection } from '@/lib/folder-utils'

type ContentMode = 'text' | 'file' | 'folder'

// Declare global for TypeScript
declare global {
  interface Window {
    testCloudTransfer?: (enable: boolean, server?: string | null) => void
  }
}

export function SendTab() {
  const [mode, setMode] = useState<ContentMode>('file')
  const [message, setMessage] = useState('')
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedServer, setSelectedServer] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null)
  const [isCompressing, setIsCompressing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)
  const { state, pin, send, cancel } = useNostrSend()

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
  const isFileOverLimit = selectedFile ? selectedFile.size > MAX_MESSAGE_SIZE : false
  const folderTotalSize = selectedFiles ? getTotalSize(selectedFiles) : 0
  const isFolderOverLimit = folderTotalSize > MAX_MESSAGE_SIZE

  const canSendText = message.trim().length > 0 && !isTextOverLimit && state.status === 'idle'
  const canSendFile = selectedFile && !isFileOverLimit && state.status === 'idle'
  const canSendFolder = selectedFiles && selectedFiles.length > 0 && !isFolderOverLimit && state.status === 'idle' && !isCompressing
  const canSend = mode === 'text' ? canSendText : mode === 'file' ? canSendFile : canSendFolder

  const handleSend = async () => {
    if (mode === 'text' && canSendText) {
      send(message, { relayOnly })
    } else if (mode === 'file' && canSendFile && selectedFile) {
      send(selectedFile, { relayOnly })
    } else if (mode === 'folder' && canSendFolder && selectedFiles) {
      setIsCompressing(true)
      try {
        const archiveName = supportsFolderSelection ? getFolderName(selectedFiles) : 'files'
        const zipFile = await compressFilesToZip(selectedFiles, archiveName)
        setIsCompressing(false)
        send(zipFile, { relayOnly })
      } catch (err) {
        setIsCompressing(false)
        console.error('Failed to compress files:', err)
      }
    }
  }

  const handleReset = () => {
    cancel()
    setMessage('')
    setSelectedFile(null)
    setSelectedFiles(null)
    if (folderInputRef.current) folderInputRef.current.value = ''
  }

  const handleFileSelect = useCallback((file: File | null) => {
    if (file) {
      setSelectedFile(file)
    }
  }, [])

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null
    handleFileSelect(file)
  }

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      setSelectedFiles(files)
    }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0] || null
    handleFileSelect(file)
  }, [handleFileSelect])

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

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <Tabs value={mode} onValueChange={(v) => setMode(v as ContentMode)}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="file" className="flex items-center gap-2">
                <FileUp className="h-4 w-4" />
                File
              </TabsTrigger>
              <TabsTrigger value="folder" className="flex items-center gap-2">
                {supportsFolderSelection ? (
                  <>
                    <FolderUp className="h-4 w-4" />
                    Folder
                  </>
                ) : (
                  <>
                    <Files className="h-4 w-4" />
                    Files
                  </>
                )}
              </TabsTrigger>
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
                  ${selectedFile ? 'bg-muted/50' : ''}
                `}
              >
                {selectedFile ? (
                  <>
                    <FileUp className="h-10 w-10 text-muted-foreground" />
                    <div className="text-center">
                      <p className="font-medium truncate max-w-[250px]">{selectedFile.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatFileSize(selectedFile.size)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedFile(null)
                        if (fileInputRef.current) fileInputRef.current.value = ''
                      }}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 text-muted-foreground" />
                    <div className="text-center">
                      <p className="font-medium">Drop file here or click to select</p>
                      <p className="text-sm text-muted-foreground">
                        Max size: {formatFileSize(MAX_MESSAGE_SIZE)}
                      </p>
                    </div>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileInputChange}
                className="hidden"
              />
              {isFileOverLimit && (
                <p className="text-xs text-destructive">
                  File exceeds {formatFileSize(MAX_MESSAGE_SIZE)} limit
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
                  ${selectedFiles ? 'bg-muted/50' : ''}
                `}
              >
                {isCompressing ? (
                  <>
                    <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
                    <div className="text-center">
                      <p className="font-medium">Compressing to ZIP...</p>
                    </div>
                  </>
                ) : selectedFiles ? (
                  <>
                    {supportsFolderSelection ? (
                      <FolderUp className="h-10 w-10 text-muted-foreground" />
                    ) : (
                      <Files className="h-10 w-10 text-muted-foreground" />
                    )}
                    <div className="text-center">
                      <p className="font-medium truncate max-w-[250px]">
                        {supportsFolderSelection ? getFolderName(selectedFiles) : `${selectedFiles.length} files`}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} &bull; {formatFileSize(folderTotalSize)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedFiles(null)
                        if (folderInputRef.current) folderInputRef.current.value = ''
                      }}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  </>
                ) : (
                  <>
                    {supportsFolderSelection ? (
                      <FolderUp className="h-10 w-10 text-muted-foreground" />
                    ) : (
                      <Files className="h-10 w-10 text-muted-foreground" />
                    )}
                    <div className="text-center">
                      <p className="font-medium">
                        {supportsFolderSelection ? 'Click to select a folder' : 'Click to select files'}
                      </p>
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
                {...(supportsFolderSelection ? { webkitdirectory: '', directory: '' } : { multiple: true })}
              />
              {isFolderOverLimit && (
                <p className="text-xs text-destructive">
                  Total size exceeds {formatFileSize(MAX_MESSAGE_SIZE)} limit
                </p>
              )}
            </div>
          )}



          {relayOnly && (
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
