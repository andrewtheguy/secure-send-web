import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Check, Copy, AlertCircle, Eye, EyeOff, Clock, Hash, MessageSquareText, Fingerprint } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PIN_DISPLAY_TIMEOUT_MS, pinToWords, computePinHint, isPasskeyPin } from '@/lib/crypto'

interface PinDisplayProps {
  pin: string
  passkeyFingerprint?: string | null
  onExpire: () => void
}

export function PinDisplay({ pin, passkeyFingerprint, onExpire }: PinDisplayProps) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const [isMasked, setIsMasked] = useState(false)
  const [useWords, setUseWords] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(Math.ceil(PIN_DISPLAY_TIMEOUT_MS / 1000))
  const [progressPercentage, setProgressPercentage] = useState(100)
  const [fingerprint, setFingerprint] = useState<string>('')

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const onExpireRef = useRef(onExpire)

  // Keep onExpire ref up to date
  useEffect(() => {
    onExpireRef.current = onExpire
  }, [onExpire])

  useEffect(() => {
    mountedRef.current = true

    // Start high-resolution countdown timer
    const durationMs = PIN_DISPLAY_TIMEOUT_MS
    const startTime = performance.now()

    const tick = () => {
      if (!mountedRef.current) return

      const now = performance.now()
      const elapsed = now - startTime
      const remainingMs = Math.max(0, durationMs - elapsed)

      setTimeRemaining(Math.ceil(remainingMs / 1000))
      setProgressPercentage((remainingMs / durationMs) * 100)

      if (remainingMs <= 0) {
        onExpireRef.current()
        return
      }

      animationFrameRef.current = requestAnimationFrame(tick)
    }

    animationFrameRef.current = requestAnimationFrame(tick)

    return () => {
      mountedRef.current = false
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])
  const isPasskey = useMemo(() => isPasskeyPin(pin), [pin])
  const words = useMemo(() => pinToWords(pin), [pin])
  const wordsDisplay = useMemo(() => words.join(' '), [words])

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

  const toggleMode = useCallback(() => {
    setUseWords((prev) => !prev)
  }, [])

  // Mask PIN with bullet characters
  const maskedPin = pin.replace(/./g, '\u2022')

  useEffect(() => {
    let cancelled = false
    const loadHint = async () => {
      try {
        const hint = await computePinHint(pin)
        if (!cancelled) {
          let formatted = ''
          if (typeof hint === 'string' && hint.length >= 8) {
            const compact = hint.slice(0, 8).toUpperCase()
            formatted = `${compact.slice(0, 4)}-${compact.slice(4, 8)}`
          }
          setFingerprint(formatted)
        }
      } catch {
        if (!cancelled) setFingerprint('')
      }
    }
    void loadHint()
    return () => { cancelled = true }
  }, [pin])

  // Format passkey fingerprint for display (e.g., "ABCD-EFGH-IJK")
  const formattedPasskeyFingerprint = useMemo(() => {
    if (!passkeyFingerprint) return ''
    const fp = passkeyFingerprint.toUpperCase()
    if (fp.length >= 11) {
      return `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 11)}`
    }
    return fp
  }, [passkeyFingerprint])

  // Dual mode: side-by-side layout
  if (passkeyFingerprint) {
    return (
      <div className="flex flex-col gap-4 p-6 rounded-lg bg-muted/50 border">
        {/* Header with timer */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            Receiver can use either option
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
            className="h-full bg-amber-600"
            style={{ width: `${progressPercentage}%` }}
          />
        </div>

        {/* Side-by-side options */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Option 1: PIN */}
          <div className="flex flex-col gap-3 p-4 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4 text-green-600" />
              <h4 className="text-sm font-medium">Option 1: PIN</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Works for any receiver - no passkey required
            </p>

            {/* PIN Display */}
            {useWords ? (
              <div className="grid grid-cols-2 gap-1.5">
                {words.map((word, i) => (
                  <div key={i} className="relative">
                    <Input
                      value={isMasked ? '\u2022\u2022\u2022\u2022\u2022' : word}
                      readOnly
                      className="text-center font-mono text-xs h-8 bg-background border-green-500/50 cursor-default select-all"
                    />
                    <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                      {i + 1}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Input
                value={isMasked ? maskedPin : pin}
                readOnly
                className="text-center font-mono text-lg tracking-wider h-10 bg-background border-green-500 cursor-default select-all"
              />
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="default"
                size="sm"
                className="flex-1"
                onClick={handleCopy}
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 mr-1" />
                    Copied!
                  </>
                ) : error ? (
                  <>
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Failed
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3 mr-1" />
                    Copy {useWords ? 'words' : 'PIN'}
                  </>
                )}
              </Button>

              {hasCopied && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleMask}
                  title={isMasked ? 'Show PIN' : 'Hide PIN'}
                >
                  {isMasked ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </Button>
              )}
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={toggleMode}
              className="text-xs"
            >
              {useWords ? 'Show as characters' : 'Show as words'}
            </Button>
          </div>

          {/* Option 2: Passkey */}
          <div className="flex flex-col gap-3 p-4 rounded-lg border border-cyan-500/50 bg-cyan-50/30 dark:bg-cyan-950/20">
            <div className="flex items-center gap-2">
              <Fingerprint className="h-4 w-4 text-cyan-600" />
              <h4 className="text-sm font-medium">Option 2: Passkey</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Receiver with same synced passkey can authenticate directly
            </p>

            {/* Passkey fingerprint display */}
            <div className="flex items-center justify-center h-10 bg-background rounded-md border border-cyan-500">
              <span className="font-mono text-cyan-600 font-medium tracking-wider">
                {formattedPasskeyFingerprint}
              </span>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              No PIN needed - receiver selects &quot;Use Passkey&quot;
            </p>

            <div className="text-xs text-muted-foreground space-y-1 mt-auto">
              <p className="flex items-center gap-1">
                <Fingerprint className="h-3 w-3" />
                Passkey Fingerprint: {formattedPasskeyFingerprint}
              </p>
            </div>
          </div>
        </div>

        {/* PIN fingerprint for verification */}
        {fingerprint && (
          <div className="text-xs text-muted-foreground border-t pt-3">
            <div className="flex items-center gap-2 font-mono">
              <Hash className="h-3 w-3" />
              PIN Fingerprint: {fingerprint}
            </div>
            <p className="mt-1">Compare with receiver to verify same PIN was entered.</p>
          </div>
        )}
      </div>
    )
  }

  // Single mode: original layout
  return (
    <div className="flex flex-col gap-4 p-6 rounded-lg bg-muted/50 border">
      {/* Header with timer */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          Share this PIN with the receiver
          {isPasskey && (
            <span className="inline-flex items-center gap-1 text-xs bg-primary/10 border border-primary/20 px-2 py-0.5 rounded">
              <Fingerprint className="h-3 w-3" />
              Passkey
            </span>
          )}
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
          className="h-full bg-amber-600"
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
                  aria-label={`PIN word ${i + 1} of ${words.length}`}
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
            aria-label="Alphanumeric PIN"
            className={`text-center font-mono text-xl tracking-wider h-12 bg-background cursor-default select-all ${
              isPasskey ? 'border-cyan-500' : 'border-green-500'
            }`}
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
        <Button
          variant="outline"
          size="sm"
          onClick={toggleMode}
          className="gap-2"
        >
          {useWords ? (
            <>
              <Hash className="h-4 w-4" />
              Switch to character PIN
            </>
          ) : (
            <>
              <MessageSquareText className="h-4 w-4" />
              Switch to words
            </>
          )}
        </Button>
      </div>

      {fingerprint && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 font-mono">
            <Fingerprint className="h-3 w-3" />
            PIN Fingerprint: {fingerprint}
          </div>
          <p>- It should match the receiver&apos;s PIN fingerprint if they entered the same words/PIN.</p>
          <p>- On the receiver&apos;s end, after the PIN is entered the app locks it into a key that cannot be read back out; this fingerprint is the one-way checksum you can compare to confirm you both derived the same secret, but it cannot be reversed to recover the PIN or decrypt any data.</p>
        </div>
      )}
    </div>
  )
}
