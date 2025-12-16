import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PinDisplayProps {
  pin: string
}

export function PinDisplay({ pin }: PinDisplayProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(pin)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col items-center gap-4 p-6 rounded-lg bg-muted">
      <p className="text-sm text-muted-foreground">Share this PIN with the receiver:</p>
      <div className="flex items-center gap-3">
        <code className="text-3xl font-mono font-bold tracking-wider px-4 py-2 bg-background rounded-md border">
          {pin}
        </code>
        <Button variant="outline" size="icon" onClick={handleCopy}>
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground text-center max-w-xs">
        The receiver will need this PIN to decrypt the message. Share it securely via another channel
        (voice, chat, etc.)
      </p>
    </div>
  )
}
