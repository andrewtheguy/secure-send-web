import { AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Input } from '@/components/ui/input';
import {
  computePinFingerprintFromRoot,
  importPinRoot,
  isValidPin,
  normalizePinInput,
  PIN_CHARSET,
  PIN_GROUP_LENGTH,
  PIN_LENGTH,
} from '@/lib/crypto';

const GROUP_COUNT = PIN_LENGTH / PIN_GROUP_LENGTH;

export interface PinChangePayload {
  key: CryptoKey | null;
  fingerprint: string | null;
  isValid: boolean;
  length: number;
}

interface PinInputProps {
  onPinChange: (payload: PinChangePayload) => void;
  disabled?: boolean;
}

export interface PinInputRef {
  clear: () => void;
}

/**
 * PIN entry as two symmetric 5-character groups (XXXXX-XXXXX).
 * Input is case-insensitive; Crockford look-alikes (O, I, L) are mapped as you
 * type, focus auto-advances between groups, and the trailing check digit
 * rejects a mistyped code the moment the last character lands.
 */
export const PinInput = forwardRef<PinInputRef, PinInputProps>(
  ({ onPinChange, disabled }, ref) => {
    const [error, setError] = useState<string | null>(null);
    const [displayLength, setDisplayLength] = useState(0);
    const [isValid, setIsValid] = useState(false);
    const [isSecured, setIsSecured] = useState(false);

    // The PIN plaintext lives only in DOM input values and this ref (cleared
    // as soon as the PIN is locked into key material), never in React state.
    const inputRefs = useRef<(HTMLInputElement | null)[]>(
      Array(GROUP_COUNT).fill(null),
    );
    const pinRef = useRef('');
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);
    const securedKeyRef = useRef<CryptoKey | null>(null);
    const securedFingerprintRef = useRef<string | null>(null);

    const clearSecuredData = useCallback(() => {
      securedKeyRef.current = null;
      securedFingerprintRef.current = null;
    }, []);

    const emitChange = useCallback(
      (valid: boolean, length: number) => {
        onPinChange({
          key: valid ? securedKeyRef.current : null,
          fingerprint: valid ? securedFingerprintRef.current : null,
          isValid: valid,
          length,
        });
      },
      [onPinChange],
    );

    const clearAll = useCallback(() => {
      clearSecuredData();
      pinRef.current = '';
      setIsValid(false);
      setIsSecured(false);
      setDisplayLength(0);
      setError(null);
      for (const input of inputRefs.current) {
        if (input) input.value = '';
      }
      emitChange(false, 0);
    }, [clearSecuredData, emitChange]);

    useImperativeHandle(ref, () => ({ clear: clearAll }));

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
    }, []);

    const flashError = useCallback((message: string) => {
      setError(message);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) setError(null);
      }, 1500);
    }, []);

    const securePin = useCallback(
      async (pin: string) => {
        if (!isValidPin(pin)) return;

        try {
          const root = await importPinRoot(pin);
          const fingerprint = await computePinFingerprintFromRoot(root);

          securedKeyRef.current = root;
          securedFingerprintRef.current = fingerprint;

          // Clear plaintext traces; show masked placeholders so users see the
          // input was captured without revealing the PIN.
          pinRef.current = '';
          for (const input of inputRefs.current) {
            if (input) input.value = '*'.repeat(PIN_GROUP_LENGTH);
          }

          setIsSecured(true);
          setIsValid(true);
          setDisplayLength(PIN_LENGTH);
          setError(null);

          emitChange(true, PIN_LENGTH);
        } catch (err) {
          console.error('Failed to secure PIN', err);
          clearSecuredData();
          emitChange(false, 0);
          setError('Failed to secure PIN');
        }
      },
      [clearSecuredData, emitChange],
    );

    // Distribute a full normalized value across the group inputs and update
    // validity/secured state.
    const applyPin = useCallback(
      (combined: string, focusIndex?: number) => {
        const value = combined.slice(0, PIN_LENGTH);
        for (let i = 0; i < GROUP_COUNT; i++) {
          const input = inputRefs.current[i];
          if (input) {
            input.value = value.slice(
              i * PIN_GROUP_LENGTH,
              (i + 1) * PIN_GROUP_LENGTH,
            );
          }
        }

        pinRef.current = value;
        setIsSecured(false);
        setDisplayLength(value.length);

        if (focusIndex !== undefined) {
          inputRefs.current[focusIndex]?.focus();
        }

        if (value.length === PIN_LENGTH && isValidPin(value)) {
          setIsValid(true);
          void securePin(value);
        } else {
          setIsValid(false);
          clearSecuredData();
          emitChange(false, value.length);
        }
      },
      [clearSecuredData, emitChange, securePin],
    );

    const readCombined = () =>
      inputRefs.current
        .map((input) => input?.value ?? '')
        .join('')
        .slice(0, PIN_LENGTH);

    const handleGroupChange = (
      index: number,
      e: React.ChangeEvent<HTMLInputElement>,
    ) => {
      // Any edit after the PIN was secured restarts entry from scratch.
      if (isSecured) {
        clearSecuredData();
        setIsSecured(false);
      }

      const normalized = normalizePinInput(e.target.value);
      const filtered = [...normalized]
        .filter((char) => PIN_CHARSET.includes(char))
        .join('');
      if (filtered.length !== normalized.length && normalized.length > 0) {
        flashError('Invalid character');
      }

      const input = inputRefs.current[index];
      if (input) input.value = filtered.slice(0, PIN_GROUP_LENGTH);

      // Auto-advance once this group is full; overflow spills into the next.
      const overflow = filtered.slice(PIN_GROUP_LENGTH);
      if (index < GROUP_COUNT - 1 && overflow) {
        const next = inputRefs.current[index + 1];
        if (next)
          next.value = (overflow + next.value).slice(0, PIN_GROUP_LENGTH);
      }
      const focusIndex =
        index < GROUP_COUNT - 1 &&
        (inputRefs.current[index]?.value.length ?? 0) === PIN_GROUP_LENGTH
          ? index + 1
          : undefined;

      applyPin(readCombined(), focusIndex);
    };

    const handleKeyDown = (
      index: number,
      e: React.KeyboardEvent<HTMLInputElement>,
    ) => {
      if (
        e.key === 'Backspace' &&
        index > 0 &&
        (inputRefs.current[index]?.value ?? '') === ''
      ) {
        inputRefs.current[index - 1]?.focus();
      }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      const normalized = normalizePinInput(e.clipboardData.getData('text'));
      const filtered = [...normalized]
        .filter((char) => PIN_CHARSET.includes(char))
        .join('');
      if (!filtered) return;

      e.preventDefault();
      if (isSecured) {
        clearSecuredData();
        setIsSecured(false);
      }
      const focusIndex = Math.min(
        Math.floor(filtered.length / PIN_GROUP_LENGTH),
        GROUP_COUNT - 1,
      );
      applyPin(filtered, focusIndex);
    };

    const isComplete = displayLength === PIN_LENGTH;
    const hasChecksumError = isComplete && !isValid;

    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-center gap-2">
          {Array.from({ length: GROUP_COUNT }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length PIN group slots; index IS the position
            <div key={i} className="flex items-center gap-2">
              {i > 0 && (
                <span className="text-xl font-mono text-muted-foreground select-none">
                  -
                </span>
              )}
              <Input
                ref={(el) => {
                  inputRefs.current[i] = el;
                }}
                type="text"
                inputMode="text"
                onChange={(e) => handleGroupChange(i, e)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                onPaste={handlePaste}
                placeholder={'•'.repeat(PIN_GROUP_LENGTH)}
                aria-label={`PIN group ${i + 1} of ${GROUP_COUNT}`}
                className={`w-32 font-mono text-xl text-center tracking-[0.25em] uppercase ${
                  error || hasChecksumError
                    ? 'border-destructive'
                    : isComplete
                      ? 'border-green-500'
                      : ''
                }`}
                maxLength={PIN_GROUP_LENGTH}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={disabled}
              />
            </div>
          ))}
        </div>

        <div className="flex justify-between items-center text-xs">
          <div className="flex items-center gap-1.5">
            {isComplete && !hasChecksumError ? (
              <span className="text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> PIN Valid
              </span>
            ) : hasChecksumError ? (
              <span className="text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Invalid PIN — check for
                typos
              </span>
            ) : (
              <span className="text-muted-foreground">
                {displayLength}/{PIN_LENGTH} characters
              </span>
            )}
            {error && <span className="text-destructive">• {error}</span>}
          </div>
          <span className="text-muted-foreground">Not case sensitive</span>
        </div>
      </div>
    );
  },
);
