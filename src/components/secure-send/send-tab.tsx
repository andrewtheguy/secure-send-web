import { useState } from 'react'
import { Send, X, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PinDisplay } from './pin-display'
import { TransferStatus } from './transfer-status'
import { useNostrSend } from '@/hooks/use-nostr-send'
import { MAX_MESSAGE_SIZE } from '@/lib/crypto'

export function SendTab() {
  const [message, setMessage] = useState('')
  const { state, pin, send, cancel } = useNostrSend()

  const encoder = new TextEncoder()
  const messageSize = encoder.encode(message).length
  const isOverLimit = messageSize > MAX_MESSAGE_SIZE
  const canSend = message.trim().length > 0 && !isOverLimit && state.status === 'idle'

  const handleSend = () => {
    if (canSend) {
      send(message)
    }
  }

  const handleReset = () => {
    cancel()
    setMessage('')
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  const isActive = state.status !== 'idle' && state.status !== 'error' && state.status !== 'complete'
  const showPinDisplay =
    pin && (state.status === 'waiting_for_receiver' || state.status === 'transferring')

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <div className="space-y-2">
            <Textarea
              placeholder="Enter your message here..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="min-h-[200px] font-mono"
              disabled={isActive}
            />
            <div className="flex justify-between text-xs">
              <span className={isOverLimit ? 'text-destructive' : 'text-muted-foreground'}>
                {formatSize(messageSize)} / {formatSize(MAX_MESSAGE_SIZE)}
              </span>
              {isOverLimit && <span className="text-destructive">Message too large</span>}
            </div>
          </div>

          <Button onClick={handleSend} disabled={!canSend} className="w-full">
            <Send className="mr-2 h-4 w-4" />
            Generate PIN & Send
          </Button>
        </>
      ) : (
        <>
          <TransferStatus state={state} />

          {showPinDisplay && <PinDisplay pin={pin} />}

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
