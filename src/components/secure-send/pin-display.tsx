import { useState, useRef, useEffect, useCallback } from 'react'
import { Check, Copy, AlertCircle, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PIN_DISPLAY_TIMEOUT_MS, pinToWords } from '@/lib/crypto'

interface PinDisplayProps {
  pin: string
  onExpire: () => void
}

export function PinDisplay({ pin, onExpire }: PinDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const [isMasked, setIsMasked] = useState(false)
  const [useWords, setUseWords] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(Math.floor(PIN_DISPLAY_TIMEOUT_MS / 1000))

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)
  const onExpireRef = useRef(onExpire)

  // Keep onExpire ref up to date
  useEffect(() => {
    onExpireRef.current = onExpire
  }, [onExpire])

  useEffect(() => {
    mountedRef.current = true

    // Start countdown timer
    intervalRef.current = setInterval(() => {
      if (!mountedRef.current) return
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          // Timer expired, call onExpire
          if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
          }
          onExpireRef.current()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => {
      mountedRef.current = false
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])
  const words = pinToWords(pin)
  const wordsDisplay = words.join(' ')

  const handleCopy = useCallback(async () => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    try {
      const textToCopy = useWords ? wordsDisplay : pin
      await navigator.clipboard.writeText(textToCopy)
      if (!mountedRef.current) return

      setError(false)
      setCopied(true)
      // Mask PIN after copying
      setHasCopied(true)
      setIsMasked(true)
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
  }, [pin, useWords, wordsDisplay])

  const toggleMask = useCallback(() => {
    setIsMasked((prev) => !prev)
  }, [])

  // Format time remaining as MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const toggleMode = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setUseWords((prev) => !prev)
  }, [])

  // Mask PIN with bullet characters
  const maskedPin = pin.replace(/./g, '\u2022')

  return (
    <div className="flex flex-col items-center gap-2 sm:gap-4 p-4 sm:p-6 rounded-lg bg-muted">
      <p className="text-sm text-muted-foreground text-center">Share this PIN with the receiver:</p>
      <div className="flex items-center gap-2 sm:gap-3">
        <code className="text-xl sm:text-3xl font-mono font-bold tracking-wider px-3 py-1 sm:px-4 sm:py-2 bg-background rounded-md border text-center max-w-full overflow-x-auto">
          {isMasked ? (useWords ? words.map(() => '\u2022\u2022\u2022').join(' ') : maskedPin) : useWords ? wordsDisplay : pin}
        </code>
        {hasCopied && (
          <Button variant="outline" size="icon" onClick={toggleMask} title={isMasked ? 'Show PIN' : 'Hide PIN'}>
            {isMasked ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        )}
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
      <p className="text-xs text-amber-600 font-medium">PIN expires in {formatTime(timeRemaining)}</p>
      <button
        onClick={toggleMode}
        className="text-xs text-primary hover:underline transition-colors"
      >
        {useWords ? '(use characters instead of words)' : '(use words instead of pin)'}
      </button>
      <p className="text-xs text-muted-foreground text-center max-w-xs">
        The receiver will need this PIN to decrypt the message. PIN is case sensitive. Share it
        securely via another channel (voice, chat, etc.)
      </p>
    </div>
  )
}
