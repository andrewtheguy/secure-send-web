import { useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Loader2, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { checkWebAuthnSupport, createPasskeyCredential } from '@/lib/crypto/passkey'
import { usePasskey } from '@/contexts/passkey-context'
import { PIN_WORDLIST } from '@/lib/crypto/constants'

/** Maximum allowed length for display name */
const MAX_NAME_LENGTH = 64

/** Allowed characters: alphanumerics, space, hyphen, underscore */
const ALLOWED_NAME_PATTERN = /^[a-zA-Z0-9 _-]*$/

function generateRandomName(): string {
  const words: string[] = []
  const randomBytes = crypto.getRandomValues(new Uint8Array(8))
  for (let i = 0; i < 4; i++) {
    const index = ((randomBytes[i * 2] << 8) | randomBytes[i * 2 + 1]) % PIN_WORDLIST.length
    words.push(PIN_WORDLIST[index])
  }
  return words.join('-')
}

/**
 * Validate display name input.
 * @returns Error message if invalid, null if valid or empty (empty uses default)
 */
function validateDisplayName(name: string): string | null {
  const trimmed = name.trim()

  // Empty is valid (will use default)
  if (!trimmed) {
    return null
  }

  // Check max length
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `Display name must be ${MAX_NAME_LENGTH} characters or less`
  }

  // Check allowed characters
  if (!ALLOWED_NAME_PATTERN.test(trimmed)) {
    return 'Display name can only contain letters, numbers, spaces, hyphens, and underscores'
  }

  return null
}

export function PasskeyCreatePage() {
  const navigate = useNavigate()
  const { pageState, setPageState, setError } = usePasskey()
  const [userName, setUserName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const defaultUserName = useMemo(() => generateRandomName(), [])

  const isLoading = pageState !== 'idle'

  const handleNameChange = useCallback((value: string) => {
    setUserName(value)
    // Validate on change for immediate feedback
    const error = validateDisplayName(value)
    setNameError(error)
  }, [])

  const handleCreatePasskey = async () => {
    setError(null)

    // Validate name before proceeding
    const trimmedName = userName.trim()
    const validationError = validateDisplayName(userName)
    if (validationError) {
      setNameError(validationError)
      return
    }

    setPageState('checking')

    try {
      const support = await checkWebAuthnSupport()
      if (!support.webauthnSupported) {
        setError(support.error || 'WebAuthn not supported')
        setPageState('idle')
        return
      }

      setPageState('creating')

      // Use trimmed name or default if empty
      const displayName = trimmedName || defaultUserName
      await createPasskeyCredential(displayName)
      setUserName('')
      setNameError(null)
      setPageState('idle')

      // Navigate to home after successful creation (passkey is for self-transfer)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create passkey')
      setPageState('idle')
    }
  }

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/passkey')}
        className="text-muted-foreground"
        disabled={isLoading}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <div className="p-4 rounded-lg border-2 border-primary/30 bg-primary/5">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Plus className="h-5 w-5" />
          Create New Passkey
        </h3>
        <p className="text-sm mt-2">
          Create a passkey to securely send files to yourself across devices without needing PINs.
        </p>

        <div className="mt-4 space-y-2">
          <Label htmlFor="userName">Display Name</Label>
          <Input
            id="userName"
            placeholder={defaultUserName}
            value={userName}
            onChange={(e) => handleNameChange(e.target.value)}
            disabled={isLoading}
            aria-invalid={!!nameError}
            aria-describedby={nameError ? 'userName-error' : undefined}
            className={nameError ? 'border-destructive' : undefined}
          />
          {nameError ? (
            <p id="userName-error" className="text-xs text-destructive">
              {nameError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Helps identify this passkey in your password manager.
            </p>
          )}
        </div>

        <Button
          onClick={handleCreatePasskey}
          disabled={isLoading || !!nameError}
          className="w-full mt-4"
          size="lg"
        >
          {pageState !== 'idle' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {pageState === 'checking' && 'Checking support...'}
              {pageState === 'creating' && 'Creating passkey...'}
            </>
          ) : (
            <>
              <Plus className="mr-2 h-4 w-4" />
              Create Passkey
            </>
          )}
        </Button>

        <p className="text-xs text-muted-foreground text-center mt-2">
          You will be prompted to create and authenticate your passkey.
        </p>
      </div>
    </div>
  )
}
