import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Loader2, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { checkWebAuthnSupport, createPasskeyCredential } from '@/lib/crypto/passkey'
import { usePasskey } from '@/contexts/passkey-context'
import { PIN_WORDLIST } from '@/lib/crypto/constants'

function generateRandomName(): string {
  const words: string[] = []
  const randomBytes = crypto.getRandomValues(new Uint8Array(8))
  for (let i = 0; i < 4; i++) {
    const index = ((randomBytes[i * 2] << 8) | randomBytes[i * 2 + 1]) % PIN_WORDLIST.length
    words.push(PIN_WORDLIST[index])
  }
  return words.join('-')
}

export function PasskeyCreatePage() {
  const navigate = useNavigate()
  const { pageState, setPageState, setError } = usePasskey()
  const [userName, setUserName] = useState('')
  const defaultUserName = useMemo(() => generateRandomName(), [])

  const isLoading = pageState !== 'idle'

  const handleCreatePasskey = async () => {
    setError(null)
    setPageState('checking')

    try {
      const support = await checkWebAuthnSupport()
      if (!support.webauthnSupported) {
        setError(support.error || 'WebAuthn not supported')
        setPageState('idle')
        return
      }

      setPageState('creating')

      await createPasskeyCredential(userName || defaultUserName)
      setUserName('')
      setPageState('idle')

      // Navigate to pairing immediately after successful creation
      navigate('/passkey/pair')
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
          Create a passkey to generate your invite code. Share it with peers for secure file
          transfers without needing PINs.
        </p>

        <div className="mt-4 space-y-2">
          <Label htmlFor="userName">Display Name</Label>
          <Input
            id="userName"
            placeholder={defaultUserName}
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            disabled={isLoading}
          />
          <p className="text-xs text-muted-foreground">
            Helps identify this passkey in your password manager.
          </p>
        </div>

        <Button
          onClick={handleCreatePasskey}
          disabled={isLoading}
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
