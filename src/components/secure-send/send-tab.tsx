import { useState, useRef, useCallback } from 'react'
import { Send, X, RotateCcw, FileUp, FileText, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PinDisplay } from './pin-display'
import { TransferStatus } from './transfer-status'
import { useNostrSend } from '@/hooks/use-nostr-send'
import { MAX_MESSAGE_SIZE } from '@/lib/crypto'
import { formatFileSize } from '@/lib/file-utils'

type ContentMode = 'text' | 'file'

export function SendTab() {
  const [mode, setMode] = useState<ContentMode>('text')
  const [message, setMessage] = useState('')
  const [relayOnly, setRelayOnly] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)
  const { state, pin, send, cancel } = useNostrSend()

  const encoder = new TextEncoder()
  const messageSize = encoder.encode(message).length
  const isTextOverLimit = messageSize > MAX_MESSAGE_SIZE
  const isFileOverLimit = selectedFile ? selectedFile.size > MAX_MESSAGE_SIZE : false

  const canSendText = message.trim().length > 0 && !isTextOverLimit && state.status === 'idle'
  const canSendFile = selectedFile && !isFileOverLimit && state.status === 'idle'
  const canSend = mode === 'text' ? canSendText : canSendFile

  const handleSend = () => {
    if (mode === 'text' && canSendText) {
      send(message, { relayOnly })
    } else if (mode === 'file' && canSendFile && selectedFile) {
      send(selectedFile, { relayOnly })
    }
  }

  const handleReset = () => {
    cancel()
    setMessage('')
    setSelectedFile(null)
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
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="text" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Text Message
              </TabsTrigger>
              <TabsTrigger value="file" className="flex items-center gap-2">
                <FileUp className="h-4 w-4" />
                File
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === 'text' ? (
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
          ) : (
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



          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="relay-only"
              checked={relayOnly}
              onChange={(e) => setRelayOnly(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <label
              htmlFor="relay-only"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Use Nostr Relay Only (disable WebRTC)
            </label>
          </div>

          <Button onClick={handleSend} disabled={!canSend} className="w-full">
            <Send className="mr-2 h-4 w-4" />
            Generate PIN & Send
          </Button>
        </>
      ) : (
        <>
          <TransferStatus
            state={state}
            mode="send"
            betweenProgressAndChunks={showPinDisplay ? <PinDisplay pin={pin} /> : undefined}
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
