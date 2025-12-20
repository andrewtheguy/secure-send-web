import { useState, useRef, useEffect, useCallback } from 'react'
import { Check, Copy, AlertCircle, Eye, EyeOff, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

  // Calculate progress percentage for timer
  const progressPercentage = (timeRemaining / (PIN_DISPLAY_TIMEOUT_MS / 1000)) * 100

  return (
    <div className="flex flex-col gap-4 p-6 rounded-lg bg-muted/50 border">
      {/* Header with timer */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Share this PIN with the receiver
        </h3>
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-amber-600" />
          <span className="font-mono font-medium text-amber-600">
            {formatTime(timeRemaining)}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-amber-600 transition-all duration-1000 ease-linear"
          style={{ width: `${progressPercentage}%` }}
        />
      </div>

      {/* PIN/Words Display */}
      {useWords ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {words.map((word, i) => (
              <div key={i} className="relative">
                <Input
                  value={isMasked ? '\u2022\u2022\u2022\u2022\u2022' : word}
                  readOnly
                  className="text-center font-mono h-10 bg-background border-green-500 bg-green-50/50 cursor-default select-all"
                />
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  {i + 1}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            value={isMasked ? maskedPin : pin}
            readOnly
            className="text-center font-mono text-xl tracking-wider h-12 bg-background border-green-500 cursor-default select-all"
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button
          variant="default"
          className="flex-1"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Copied!
            </>
          ) : error ? (
            <>
              <AlertCircle className="h-4 w-4 mr-2" />
              Failed to copy
            </>
          ) : (
            <>
              <Copy className="h-4 w-4 mr-2" />
              Copy {useWords ? 'words' : 'PIN'}
            </>
          )}
        </Button>

        {hasCopied && (
          <Button
            variant="outline"
            size="icon"
            onClick={toggleMask}
            title={isMasked ? 'Show PIN' : 'Hide PIN'}
          >
            {isMasked ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {/* Info and toggle */}
      <div className="flex flex-col gap-3 items-center">
        <button
          onClick={toggleMode}
          className="text-sm text-primary hover:underline transition-colors font-medium"
        >
          {useWords ? 'Use character PIN instead' : 'Use words representation'}
        </button>

        <div className="flex flex-col gap-1.5 text-center">
          {useWords ? (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Words are easier to share by voice</span> - no confusion about case or special characters
              </p>
              <p className="text-xs text-muted-foreground">
                Share securely via another channel (phone call, video chat, etc.)
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Character PIN is shorter to type</span> but case sensitive
              </p>
              <p className="text-xs text-muted-foreground">
                Best for secure messaging apps. For voice calls, consider using words instead
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
