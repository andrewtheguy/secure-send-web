import { useState, useRef, useEffect, useCallback } from 'react'
import { Check, Copy, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PinDisplayProps {
  pin: string
}

export function PinDisplay({ pin }: PinDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const handleCopy = useCallback(async () => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    try {
      await navigator.clipboard.writeText(pin)
      if (!mountedRef.current) return

      setError(false)
      setCopied(true)
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setCopied(false)
        }
      }, 2000)
    } catch {
      if (!mountedRef.current) return

      setError(true)
      setCopied(false)
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setError(false)
        }
      }, 2000)
    }
  }, [pin])

  return (
    <div className="flex flex-col items-center gap-4 p-6 rounded-lg bg-muted">
      <p className="text-sm text-muted-foreground">Share this PIN with the receiver:</p>
      <div className="flex items-center gap-3">
        <code className="text-3xl font-mono font-bold tracking-wider px-4 py-2 bg-background rounded-md border">
          {pin}
        </code>
        <Button variant="outline" size="icon" onClick={handleCopy}>
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : error ? (
            <AlertCircle className="h-4 w-4 text-destructive" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground text-center max-w-xs">
        The receiver will need this PIN to decrypt the message. PIN is case sensitive. Share it
        securely via another channel (voice, chat, etc.)
      </p>
    </div>
  )
}
