import { useState, useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react'
import { X, CheckCircle2, AlertCircle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  PIN_LENGTH,
  PIN_CHARSET,
  isValidPin,
  wordsToPin,
  isValidPinWord,
  pinToWords,
  PIN_WORDLIST,
} from '@/lib/crypto'

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
    const [useWords, setUseWords] = useState(false)
    const [words, setWords] = useState<string[]>(Array(7).fill(''))
    const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null)
    const [suggestions, setSuggestions] = useState<string[]>([])
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [error, setError] = useState<string | null>(null)
    const [displayLength, setDisplayLength] = useState(0)

    const inputRefs = useRef<(HTMLInputElement | null)[]>(Array(7).fill(null))
    const charInputRef = useRef<HTMLInputElement>(null)
    const pinRef = useRef('')
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const mountedRef = useRef(true)

    useImperativeHandle(ref, () => ({
      clear: () => {
        pinRef.current = ''
        setDisplayLength(0)
        setWords(Array(7).fill(''))
        if (charInputRef.current) charInputRef.current.value = ''
      },
      getValue: () => pinRef.current,
    }))

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
      }
    }, [])

    // Notify parent whenever PIN changes
    const updatePin = useCallback((newPin: string) => {
      pinRef.current = newPin
      const isPinValid = isValidPin(newPin)
      onPinChange(newPin, isPinValid)
    }, [onPinChange])

    // Handling character mode changes
    const handleCharChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      const validChars = [...newValue].filter((char) => PIN_CHARSET.includes(char))

      if (validChars.length !== newValue.length && newValue.length > 0) {
        setError('Invalid character')
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = setTimeout(() => setError(null), 1500)
      }

      const filtered = validChars.slice(0, PIN_LENGTH).join('')
      setDisplayLength(filtered.length)
      if (charInputRef.current) charInputRef.current.value = filtered
      updatePin(filtered)
    }

    // Handling word changes
    const handleWordChange = (index: number, val: string) => {
      const newWords = [...words]
      newWords[index] = val.toLowerCase().replace(/[^a-z]/g, '')
      setWords(newWords)

      // Filter suggestions
      if (newWords[index].length >= 2) {
        const matches = PIN_WORDLIST.filter(w => w.startsWith(newWords[index])).slice(0, 5)
        setSuggestions(matches)
        setSelectedIndex(0)
      } else {
        setSuggestions([])
      }

      const pin = wordsToPin(newWords)
      setDisplayLength(newWords.filter(w => isValidPinWord(w)).length)
      updatePin(pin)
    }

    const selectSuggestion = (wordIndex: number, suggestion: string) => {
      const newWords = [...words]
      newWords[wordIndex] = suggestion
      setWords(newWords)
      setSuggestions([])

      // Focus next box
      if (wordIndex < 6) {
        inputRefs.current[wordIndex + 1]?.focus()
      }

      const pin = wordsToPin(newWords)
      setDisplayLength(newWords.filter(w => isValidPinWord(w)).length)
      updatePin(pin)
    }

    const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIndex(prev => (prev + 1) % suggestions.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          selectSuggestion(index, suggestions[selectedIndex])
          return
        }
        if (e.key === 'Escape') {
          setSuggestions([])
          return
        }
      }

      if (e.key === 'Backspace' && words[index] === '' && index > 0) {
        inputRefs.current[index - 1]?.focus()
      } else if ((e.key === ' ' || e.key === 'Enter') && words[index] !== '') {
        e.preventDefault()
        if (isValidPinWord(words[index]) && index < 6) {
          inputRefs.current[index + 1]?.focus()
        }
      }
    }

    const toggleMode = (e: React.MouseEvent) => {
      e.preventDefault()
      const currentPin = pinRef.current
      setUseWords(prev => !prev)
      if (!useWords) {
        setWords(pinToWords(currentPin))
      } else {
        if (charInputRef.current) charInputRef.current.value = currentPin
      }
    }

    const isComplete = useWords
      ? words.length === 7 && words.every(w => isValidPinWord(w))
      : displayLength === PIN_LENGTH
    const hasChecksumError = isComplete && !isValidPin(pinRef.current)

    return (
      <div className="flex flex-col gap-4">
        {useWords ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {words.map((word, i) => (
              <div key={i} className="relative group">
                <Input
                  ref={el => { inputRefs.current[i] = el }}
                  value={word}
                  onChange={e => handleWordChange(i, e.target.value)}
                  onKeyDown={e => handleKeyDown(i, e)}
                  onFocus={() => setActiveWordIndex(i)}
                  onBlur={() => setTimeout(() => setActiveWordIndex(null), 200)}
                  placeholder={`Word ${i + 1}`}
                  className={`pr-7 text-center font-mono h-10 ${word === '' ? '' : isValidPinWord(word) ? 'border-green-500 bg-green-50/50' : 'border-destructive bg-destructive/5'
                    }`}
                  autoComplete="off"
                  disabled={disabled}
                />
                {word && (
                  <button
                    onClick={() => handleWordChange(i, '')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    type="button"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                {activeWordIndex === i && suggestions.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg overflow-hidden animate-in fade-in zoom-in duration-200">
                    {suggestions.map((s, si) => (
                      <button
                        key={si}
                        className={`w-full text-left px-3 py-1.5 text-sm font-mono transition-colors ${si === selectedIndex ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                          }`}
                        onClick={() => selectSuggestion(i, s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Input
            ref={charInputRef}
            type="text"
            defaultValue={pinRef.current}
            onChange={handleCharChange}
            placeholder={`Enter ${PIN_LENGTH}-character PIN`}
            className={`font-mono text-xl text-center tracking-wider ${error || hasChecksumError ? 'border-destructive' : isComplete ? 'border-green-500' : ''
              }`}
            maxLength={PIN_LENGTH}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
        )}

        <div className="flex justify-between items-center text-xs">
          <div className="flex items-center gap-1.5">
            {isComplete && !hasChecksumError ? (
              <span className="text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> PIN Valid
              </span>
            ) : hasChecksumError ? (
              <span className="text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Invalid PIN
              </span>
            ) : (
              <span className="text-muted-foreground">
                {useWords
                  ? `${words.filter(w => isValidPinWord(w)).length}/7 words validated`
                  : `${displayLength}/${PIN_LENGTH} characters`}
              </span>
            )}
            {error && <span className="text-destructive">• {error}</span>}
          </div>

          <button
            onClick={toggleMode}
            className="text-primary hover:underline transition-colors font-medium"
            type="button"
          >
            {useWords ? 'Use character PIN' : 'Use words representation'}
          </button>
        </div>
      </div>
    )
  }
)
