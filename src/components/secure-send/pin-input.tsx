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
  computePinFingerprint,
  importPinRoot,
  isValidPin,
  normalizePinInput,
  PIN_CHARSET,
  PIN_GROUP_LENGTH,
  PIN_LENGTH,
} from '@/lib/crypto';

const GROUP_COUNT = PIN_LENGTH / PIN_GROUP_LENGTH;
const MASK_CHAR = '*';

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
 * Normalize one group's raw input, tracking how many normalized characters
 * fall before the caret. Separators and the mask character are dropped
 * silently; anything else outside the PIN charset is dropped and flagged.
 */
function normalizeGroupInput(
  raw: string,
  caret: number,
): { value: string; caret: number; invalid: boolean } {
  let value = '';
  let caretOut = 0;
  let invalid = false;
  for (let i = 0; i < raw.length; i++) {
    const normalized = normalizePinInput(raw[i]);
    let kept = '';
    if (normalized) {
      if (PIN_CHARSET.includes(normalized)) {
        kept = normalized;
      } else if (normalized !== MASK_CHAR) {
        invalid = true;
      }
    }
    value += kept;
    if (i < caret) caretOut += kept.length;
  }
  return { value, caret: caretOut, invalid };
}

/**
 * PIN entry as two symmetric 5-character groups (XXXXX-XXXXX), backed by a
 * single controlled `pin` string so mid-string edits behave like a normal
 * text field: the caret stays where you type, deletions pull later characters
 * left across the group boundary, and insertions push them right.
 *
 * Input is case-insensitive; Crockford look-alikes (O, I, L) are mapped as
 * you type and the trailing check digit rejects a mistyped code the moment
 * the last character lands. A complete, valid PIN is immediately stretched
 * into a non-extractable CryptoKey and the inputs switch to a masked display;
 * editing after that restarts entry.
 */
export const PinInput = forwardRef<PinInputRef, PinInputProps>(
  ({ onPinChange, disabled }, ref) => {
    const [pin, setPin] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isSecured, setIsSecured] = useState(false);

    const inputRefs = useRef<(HTMLInputElement | null)[]>(
      Array(GROUP_COUNT).fill(null),
    );
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Bumped on every edit so an in-flight key derivation from a superseded
    // PIN value is discarded instead of clobbering the newer input.
    const generationRef = useRef(0);
    const securedKeyRef = useRef<CryptoKey | null>(null);
    const securedFingerprintRef = useRef<string | null>(null);

    useEffect(() => {
      return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
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
      generationRef.current++;
      securedKeyRef.current = null;
      securedFingerprintRef.current = null;
      setPin('');
      setIsSecured(false);
      setError(null);
      emitChange(false, 0);
    }, [emitChange]);

    useImperativeHandle(ref, () => ({ clear: clearAll }));

    const flashError = useCallback((message: string) => {
      setError(message);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setError(null), 1500);
    }, []);

    const securePin = useCallback(
      async (candidate: string) => {
        const generation = generationRef.current;
        try {
          const [root, fingerprint] = await Promise.all([
            importPinRoot(candidate),
            computePinFingerprint(candidate),
          ]);
          if (generationRef.current !== generation) return;

          securedKeyRef.current = root;
          securedFingerprintRef.current = fingerprint;
          setPin('');
          setIsSecured(true);
          setError(null);
          emitChange(true, PIN_LENGTH);
        } catch (err) {
          if (generationRef.current !== generation) return;
          console.error('Failed to secure PIN', err);
          securedKeyRef.current = null;
          securedFingerprintRef.current = null;
          emitChange(false, candidate.length);
          setError('Failed to secure PIN');
        }
      },
      [emitChange],
    );

    /**
     * Commit a new PIN value and caret position (global, 0..PIN_LENGTH).
     * The DOM is synced here as well as via the controlled render: when
     * normalization rejects a keystroke the state may not change at all, so
     * React bails out of re-rendering and the raw character would otherwise
     * stay visible.
     */
    const commitPin = (value: string, caret: number) => {
      generationRef.current++;
      securedKeyRef.current = null;
      securedFingerprintRef.current = null;
      setIsSecured(false);
      setPin(value);

      for (let i = 0; i < GROUP_COUNT; i++) {
        const input = inputRefs.current[i];
        if (input) {
          input.value = value.slice(
            i * PIN_GROUP_LENGTH,
            (i + 1) * PIN_GROUP_LENGTH,
          );
        }
      }

      const clamped = Math.min(caret, value.length);
      const focusIndex = Math.min(
        Math.floor(clamped / PIN_GROUP_LENGTH),
        GROUP_COUNT - 1,
      );
      const focusInput = inputRefs.current[focusIndex];
      if (focusInput) {
        const localCaret = clamped - focusIndex * PIN_GROUP_LENGTH;
        focusInput.focus();
        focusInput.setSelectionRange(localCaret, localCaret);
      }

      if (value.length === PIN_LENGTH && isValidPin(value)) {
        void securePin(value);
      } else {
        emitChange(false, value.length);
      }
    };

    const handleGroupChange = (
      index: number,
      e: React.ChangeEvent<HTMLInputElement>,
    ) => {
      const input = e.target;
      const rawCaret = input.selectionStart ?? input.value.length;
      const {
        value: groupValue,
        caret: groupCaret,
        invalid,
      } = normalizeGroupInput(input.value, rawCaret);
      if (invalid) flashError('Invalid character');

      // Any edit after the PIN was secured restarts entry from whatever
      // real characters were just typed over the mask.
      const before = isSecured ? '' : pin.slice(0, index * PIN_GROUP_LENGTH);
      const after = isSecured ? '' : pin.slice((index + 1) * PIN_GROUP_LENGTH);
      const combined = (before + groupValue + after).slice(0, PIN_LENGTH);
      commitPin(combined, before.length + groupCaret);
    };

    const handleKeyDown = (
      index: number,
      e: React.KeyboardEvent<HTMLInputElement>,
    ) => {
      // Backspace at the start of a group deletes across the group boundary.
      if (e.key !== 'Backspace' || index === 0) return;
      const input = e.currentTarget;
      if (input.selectionStart !== 0 || input.selectionEnd !== 0) return;
      e.preventDefault();

      if (isSecured) {
        commitPin('', 0);
        return;
      }
      const caret = index * PIN_GROUP_LENGTH - 1;
      commitPin(pin.slice(0, caret) + pin.slice(caret + 1), caret);
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const { value } = normalizeGroupInput(e.clipboardData.getData('text'), 0);
      if (!value) return;
      const combined = value.slice(0, PIN_LENGTH);
      commitPin(combined, combined.length);
    };

    const displayLength = isSecured ? PIN_LENGTH : pin.length;
    const isComplete = displayLength === PIN_LENGTH;
    const isValid = isSecured || (isComplete && isValidPin(pin));
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
                value={
                  isSecured
                    ? MASK_CHAR.repeat(PIN_GROUP_LENGTH)
                    : pin.slice(
                        i * PIN_GROUP_LENGTH,
                        (i + 1) * PIN_GROUP_LENGTH,
                      )
                }
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
