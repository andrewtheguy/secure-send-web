import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, X, RotateCcw, Check, Copy, FileDown, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PinInput, type PinInputRef } from './pin-input'
import { TransferStatus } from './transfer-status'
import { useNostrReceive } from '@/hooks/use-nostr-receive'
import { PIN_LENGTH } from '@/lib/crypto'
import { downloadFile, formatFileSize, getMimeTypeDescription } from '@/lib/file-utils'

export function ReceiveTab() {
  // Store PIN in ref to avoid React DevTools exposure
  const pinRef = useRef('')
  const pinInputRef = useRef<PinInputRef>(null)
  const [pinLength, setPinLength] = useState(0)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const { state, receivedContent, receive, cancel, reset } = useNostrReceive()

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Clear PIN from memory on unmount
      pinRef.current = ''
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const canReceive = pinLength === PIN_LENGTH && state.status === 'idle'

  const handleReceive = () => {
    if (canReceive && pinRef.current) {
      const pin = pinRef.current
      // Clear PIN immediately after getting it
      pinRef.current = ''
      setPinLength(0)
      pinInputRef.current?.clear()
      // Pass PIN to receive function
      receive(pin)
    }
  }

  const handleReset = () => {
    reset()
    // Clear PIN from ref and input
    pinRef.current = ''
    setPinLength(0)
    pinInputRef.current?.clear()
    setCopied(false)
    setCopyError(false)
  }

  const handlePinChange = useCallback((value: string) => {
    pinRef.current = value
    setPinLength(value.length)
  }, [])

  const handleCopy = useCallback(async () => {
    if (receivedContent?.contentType !== 'text') return

    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    try {
      await navigator.clipboard.writeText(receivedContent.message)
      if (!mountedRef.current) return

      setCopyError(false)
      setCopied(true)
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setCopied(false)
        }
      }, 2000)
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
      if (!mountedRef.current) return

      setCopied(false)
      setCopyError(true)
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setCopyError(false)
        }
      }, 2000)
    }
  }, [receivedContent])

  const handleDownload = () => {
    if (receivedContent?.contentType === 'file') {
      downloadFile(receivedContent.data, receivedContent.fileName, receivedContent.mimeType)
    }
  }

  const isActive = state.status !== 'idle' && state.status !== 'error' && state.status !== 'complete'

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium">Enter PIN from sender</label>
            <PinInput ref={pinInputRef} onPinChange={handlePinChange} disabled={isActive} />
          </div>

          <Button onClick={handleReceive} disabled={!canReceive} className="w-full">
            <Download className="mr-2 h-4 w-4" />
            Receive
          </Button>
        </>
      ) : (
        <>
          <TransferStatus state={state} />

          {state.status === 'complete' && receivedContent?.contentType === 'text' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Received Message</label>
                <Button variant="ghost" size="sm" onClick={handleCopy}>
                  {copied ? (
                    <>
                      <Check className="mr-1 h-3 w-3 text-green-500" />
                      Copied
                    </>
                  ) : copyError ? (
                    <>
                      <AlertCircle className="mr-1 h-3 w-3 text-destructive" />
                      Failed
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-3 w-3" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              <Textarea
                value={receivedContent.message}
                readOnly
                className="min-h-[200px] font-mono bg-muted"
              />
            </div>
          )}

          {state.status === 'complete' && receivedContent?.contentType === 'file' && (
            <div className="space-y-4">
              <div className="p-6 border rounded-lg bg-muted/50 text-center space-y-3">
                <FileDown className="h-12 w-12 mx-auto text-muted-foreground" />
                <div>
                  <p className="font-medium truncate max-w-[300px] mx-auto">
                    {receivedContent.fileName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatFileSize(receivedContent.fileSize)} &bull;{' '}
                    {getMimeTypeDescription(receivedContent.mimeType)}
                  </p>
                </div>
                <Button onClick={handleDownload} className="w-full max-w-[200px]">
                  <Download className="mr-2 h-4 w-4" />
                  Download File
                </Button>
              </div>
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
                Receive Another
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
