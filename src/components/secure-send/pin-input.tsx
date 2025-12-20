import { useState, useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react'
import { X, CheckCircle2, AlertCircle, ClipboardPaste } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
    const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
        if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
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

    // Handle focus on word input field
    const handleFocus = useCallback((index: number) => {
      // Cancel any pending blur timeout to prevent it from clearing suggestions
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current)
        blurTimeoutRef.current = null
      }

      setActiveWordIndex(index)
      const currentWord = words[index]

      if (currentWord === '') {
        setSuggestions(PIN_WORDLIST)  // Show all words
        setSelectedIndex(0)
      } else {
        const matches = PIN_WORDLIST.filter(w => w.startsWith(currentWord))
        setSuggestions(matches)
        setSelectedIndex(0)
      }
    }, [words])

    // Handle blur on word input field
    const handleBlur = useCallback(() => {
      blurTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setActiveWordIndex(null)
          setSuggestions([])
        }
      }, 200)
    }, [])

    // Handling word changes
    const handleWordChange = (index: number, val: string) => {
      const newWords = [...words]
      newWords[index] = val.toLowerCase().replace(/[^a-z]/g, '')
      setWords(newWords)

      // Filter suggestions - now starts at 1 character
      if (newWords[index].length >= 1) {
        const matches = PIN_WORDLIST.filter(w => w.startsWith(newWords[index]))
        setSuggestions(matches)
        setSelectedIndex(0)
      } else if (newWords[index].length === 0 && activeWordIndex === index) {
        setSuggestions(PIN_WORDLIST)  // Show all when cleared while focused
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

    const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>, fieldIndex: number) => {
      const pastedText = e.clipboardData.getData('text')

      // Split by spaces, newlines, tabs, commas
      const potentialWords = pastedText
        .toLowerCase()
        .split(/[\s,]+/)
        .map(w => w.replace(/[^a-z]/g, ''))
        .filter(w => w.length > 0)

      // If only one word, let default paste handle it
      if (potentialWords.length <= 1) return

      e.preventDefault()

      // Validate all words
      const validWords = potentialWords.slice(0, 7)
      const allValid = validWords.every(w => isValidPinWord(w))

      if (!allValid) {
        setError('Some pasted words are invalid')
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = setTimeout(() => setError(null), 3000)
        return
      }

      // Populate fields starting from current field
      const newWords = [...words]
      validWords.forEach((word, i) => {
        const targetIndex = fieldIndex + i
        if (targetIndex < 7) {
          newWords[targetIndex] = word
        }
      })

      setWords(newWords)
      setSuggestions([])

      const pin = wordsToPin(newWords)
      setDisplayLength(newWords.filter(w => isValidPinWord(w)).length)
      updatePin(pin)

      // Focus field after last pasted word
      const nextFocusIndex = Math.min(fieldIndex + validWords.length, 6)
      inputRefs.current[nextFocusIndex]?.focus()
    }, [words, updatePin])

    const handlePasteFromClipboard = useCallback(async () => {
      try {
        const text = await navigator.clipboard.readText()
        const potentialWords = text
          .toLowerCase()
          .split(/[\s,]+/)
          .map(w => w.replace(/[^a-z]/g, ''))
          .filter(w => w.length > 0)
          .slice(0, 7)

        const allValid = potentialWords.every(w => isValidPinWord(w))

        if (!allValid) {
          setError('Clipboard contains invalid words')
          if (timeoutRef.current) clearTimeout(timeoutRef.current)
          timeoutRef.current = setTimeout(() => setError(null), 3000)
          return
        }

        const newWords = Array(7).fill('')
        potentialWords.forEach((word, i) => {
          newWords[i] = word
        })

        setWords(newWords)
        setError(null)

        const pin = wordsToPin(newWords)
        setDisplayLength(potentialWords.length)
        updatePin(pin)

        const nextIndex = potentialWords.length < 7 ? potentialWords.length : 6
        inputRefs.current[nextIndex]?.focus()
      } catch (err) {
        setError('Failed to read clipboard')
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = setTimeout(() => setError(null), 3000)
      }
    }, [updatePin])

    const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const maxVisible = Math.min(10, suggestions.length)
          setSelectedIndex(prev => (prev + 1) % maxVisible)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          const maxVisible = Math.min(10, suggestions.length)
          setSelectedIndex(prev => (prev - 1 + maxVisible) % maxVisible)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          selectSuggestion(index, suggestions[selectedIndex])
          return
        }
        if (e.key === 'Tab') {
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
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {words.map((word, i) => (
                <div key={i} className="relative group">
                  <Input
                    ref={el => { inputRefs.current[i] = el }}
                    value={word}
                    onChange={e => handleWordChange(i, e.target.value)}
                    onKeyDown={e => handleKeyDown(i, e)}
                    onPaste={e => handlePaste(e, i)}
                    onFocus={() => handleFocus(i)}
                    onBlur={() => handleBlur()}
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
                    <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-[200px] overflow-y-auto animate-in fade-in zoom-in duration-200">
                      {suggestions.slice(0, 10).map((s, si) => (
                        <button
                          key={si}
                          className={`w-full text-left px-3 py-1.5 text-sm font-mono transition-colors ${si === selectedIndex ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                            }`}
                          onMouseEnter={() => setSelectedIndex(si)}
                          onClick={() => selectSuggestion(i, s)}
                        >
                          {s}
                        </button>
                      ))}
                      {suggestions.length > 10 && (
                        <div className="px-3 py-1.5 text-xs text-muted-foreground border-t">
                          +{suggestions.length - 10} more matches
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handlePasteFromClipboard}
              disabled={disabled}
              className="w-full"
              type="button"
            >
              <ClipboardPaste className="h-4 w-4 mr-2" />
              Paste all words from clipboard
            </Button>
          </>
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
