import { useState } from 'react'
import { Download, X, RotateCcw, Check, Copy, FileDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PinInput } from './pin-input'
import { TransferStatus } from './transfer-status'
import { useNostrReceive } from '@/hooks/use-nostr-receive'
import { PIN_LENGTH } from '@/lib/crypto'
import { downloadFile, formatFileSize, getMimeTypeDescription } from '@/lib/file-utils'

export function ReceiveTab() {
  const [pin, setPin] = useState('')
  const [copied, setCopied] = useState(false)
  const { state, receivedContent, receive, cancel, reset } = useNostrReceive()

  const canReceive = pin.length === PIN_LENGTH && state.status === 'idle'

  const handleReceive = () => {
    if (canReceive) {
      receive(pin)
    }
  }

  const handleReset = () => {
    reset()
    setPin('')
    setCopied(false)
  }

  const handleCopy = async () => {
    if (receivedContent?.contentType === 'text') {
      await navigator.clipboard.writeText(receivedContent.message)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

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
            <PinInput value={pin} onChange={setPin} disabled={isActive} />
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
