import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react'
import { Input } from '@/components/ui/input'
import { PIN_LENGTH, PIN_CHARSET, isValidPin, wordsToPin, isValidPinWord, pinToWords } from '@/lib/crypto'

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
    const [useWords, setUseWords] = useState(false)
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

    const handleWordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const words = e.target.value.trim().split(/\s+/)
      const lastWord = words[words.length - 1]

      // Validate words as they are typed
      if (lastWord && !isValidPinWord(lastWord) && !e.target.value.endsWith(' ')) {
        setError(`Invalid word: ${lastWord}`)
      } else {
        setError(null)
      }

      const validWords = words.filter((w) => isValidPinWord(w)).slice(0, PIN_LENGTH)
      const pin = wordsToPin(validWords)

      pinRef.current = pin
      setDisplayLength(validWords.length)

      // Update input value directly for uncontrolled behavior
      if (inputRef.current) {
        inputRef.current.value = e.target.value
      }

      const isPinValid = validWords.length === PIN_LENGTH && isValidPin(pin)
      onPinChange(pin, isPinValid)
    }

    const toggleMode = (e: React.MouseEvent) => {
      e.preventDefault()
      const currentPin = pinRef.current
      setUseWords((prev) => {
        const nextUseWords = !prev
        if (inputRef.current) {
          if (nextUseWords) {
            inputRef.current.value = pinToWords(currentPin).join(' ')
          } else {
            inputRef.current.value = currentPin
          }
        }
        return nextUseWords
      })
    }

    const isComplete = displayLength === PIN_LENGTH
    const hasChecksumError = isComplete && !isValidPin(pinRef.current)

    return (
      <div className="flex flex-col gap-2">
        <Input
          ref={inputRef}
          type="text"
          defaultValue=""
          onChange={useWords ? handleWordChange : handleChange}
          placeholder={useWords ? `Enter ${PIN_LENGTH}-word PIN` : `Enter ${PIN_LENGTH}-character PIN`}
          className={`font-mono ${useWords ? 'text-base' : 'text-xl'} text-center tracking-wider ${error || hasChecksumError
            ? 'border-destructive'
            : isComplete
              ? 'border-green-500'
              : ''
            }`}
          maxLength={useWords ? 255 : PIN_LENGTH}
          disabled={disabled}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="flex justify-between text-xs">
          <span className={error || hasChecksumError ? 'text-destructive' : 'text-muted-foreground'}>
            {error ||
              (hasChecksumError
                ? 'Invalid PIN'
                : `${displayLength}/${PIN_LENGTH} ${useWords ? 'words' : 'characters'} (case sensitive)`)}
          </span>
          <button
            onClick={toggleMode}
            className="text-primary hover:underline transition-colors focus:outline-none"
            type="button"
          >
            {useWords ? '(use characters instead of words)' : '(use words instead of pin)'}
          </button>
        </div>
        {isComplete && !hasChecksumError && (
          <div className="text-center">
            <span className="text-xs text-green-500">PIN ready</span>
          </div>
        )}
      </div>
    )
  }
)
