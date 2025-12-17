import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react'
import { Input } from '@/components/ui/input'
import { PIN_LENGTH, PIN_CHARSET, isValidPin } from '@/lib/crypto'

interface PinInputProps {
  onPinChange: (pin: string, isValid: boolean) => void
  disabled?: boolean
}

export interface PinInputRef {
  clear: () => void
  getValue: () => string
}

export const PinInput = forwardRef<PinInputRef, PinInputProps>(
  ({ onPinChange, disabled }, ref) => {
    const [error, setError] = useState<string | null>(null)
    const [displayLength, setDisplayLength] = useState(0)
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const mountedRef = useRef(true)
    const inputRef = useRef<HTMLInputElement>(null)
    // Store PIN in ref to avoid React DevTools exposure
    const pinRef = useRef('')

    useImperativeHandle(ref, () => ({
      clear: () => {
        pinRef.current = ''
        setDisplayLength(0)
        if (inputRef.current) {
          inputRef.current.value = ''
        }
      },
      getValue: () => pinRef.current,
    }))

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        // Clear PIN from memory on unmount
        pinRef.current = ''
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
      }
    }, [])

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value

      // Validate each character
      const validChars = [...newValue].filter((char) => PIN_CHARSET.includes(char))

      if (validChars.length !== newValue.length && newValue.length > 0) {
        // Clear any existing timeout before creating a new one
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        setError('Invalid character')
        timeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            setError(null)
          }
          timeoutRef.current = null
        }, 1500)
      }

      // Only allow valid characters and limit length
      const filtered = validChars.slice(0, PIN_LENGTH).join('')

      // Store in ref (not state) for security
      pinRef.current = filtered
      setDisplayLength(filtered.length)

      // Update input value directly for uncontrolled behavior
      if (inputRef.current) {
        inputRef.current.value = filtered
      }

      // Validate checksum when PIN is complete
      const isPinValid = filtered.length === PIN_LENGTH && isValidPin(filtered)

      // Notify parent of change with validity
      onPinChange(filtered, isPinValid)
    }

    const isComplete = displayLength === PIN_LENGTH
    const hasChecksumError = isComplete && !isValidPin(pinRef.current)

    return (
      <div className="flex flex-col gap-2">
        <Input
          ref={inputRef}
          type="text"
          defaultValue=""
          onChange={handleChange}
          placeholder={`Enter ${PIN_LENGTH}-character PIN`}
          className={`font-mono text-xl text-center tracking-wider ${
            error || hasChecksumError
              ? 'border-destructive'
              : isComplete
                ? 'border-green-500'
                : ''
          }`}
          maxLength={PIN_LENGTH}
          disabled={disabled}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="flex justify-between text-xs">
          <span className={error || hasChecksumError ? 'text-destructive' : 'text-muted-foreground'}>
            {error || (hasChecksumError ? 'Invalid PIN' : `${displayLength}/${PIN_LENGTH} characters (case sensitive)`)}
          </span>
          {isComplete && !hasChecksumError && <span className="text-green-500">PIN ready</span>}
        </div>
      </div>
    )
  }
)
