import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, X, RotateCcw, FileUp, FileText, Upload, Cloud, FolderUp, Loader2 } from 'lucide-react'
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
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedServer, setSelectedServer] = useState<string | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [folderFiles, setFolderFiles] = useState<FileList | null>(null) // Keep FileList for folder to preserve paths
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
  const filesTotalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0)
  const folderTotalSize = folderFiles ? getTotalSize(folderFiles) : 0
  const isFilesOverLimit = filesTotalSize > MAX_MESSAGE_SIZE
  const isFolderOverLimit = folderTotalSize > MAX_MESSAGE_SIZE

  const canSendText = message.trim().length > 0 && !isTextOverLimit && state.status === 'idle'
  const canSendFiles = selectedFiles.length > 0 && !isFilesOverLimit && state.status === 'idle' && !isCompressing
  const canSendFolder = folderFiles && folderFiles.length > 0 && !isFolderOverLimit && state.status === 'idle' && !isCompressing
  const canSend = mode === 'text' ? canSendText : mode === 'file' ? canSendFiles : canSendFolder

  const handleSend = async () => {
    if (mode === 'text' && canSendText) {
      send(message, { relayOnly })
    } else if (mode === 'file' && canSendFiles) {
      // Single file: send directly
      if (selectedFiles.length === 1) {
        send(selectedFiles[0], { relayOnly })
        return
      }
      // Multiple files: compress to ZIP
      setIsCompressing(true)
      try {
        // Convert File[] to a fake FileList-like structure for compressFilesToZip
        const dataTransfer = new DataTransfer()
        selectedFiles.forEach(f => dataTransfer.items.add(f))
        const zipFile = await compressFilesToZip(dataTransfer.files, 'files')
        setIsCompressing(false)
        send(zipFile, { relayOnly })
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
        send(zipFile, { relayOnly })
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

  const addFiles = useCallback((files: FileList | null) => {
    if (files && files.length > 0) {
      // Add to existing files, avoiding duplicates by name+size
      setSelectedFiles(prev => {
        const newFiles = Array.from(files)
        const existingKeys = new Set(prev.map(f => `${f.name}-${f.size}`))
        const uniqueNew = newFiles.filter(f => !existingKeys.has(`${f.name}-${f.size}`))
        return [...prev, ...uniqueNew]
      })
    }
  }, [])

  const removeFile = useCallback((index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files)
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
    addFiles(e.dataTransfer.files)
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

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <Tabs value={mode} onValueChange={(v) => setMode(v as ContentMode)}>
            <TabsList className={`grid w-full ${supportsFolderSelection ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <TabsTrigger value="file" className="flex items-center gap-2">
                <FileUp className="h-4 w-4" />
                File
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
