import { useNavigate, Link } from 'react-router-dom'
import { Plus, CheckCircle2, Key, ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePasskey } from '@/contexts/passkey-context'

export function PasskeyPairPage() {
  const navigate = useNavigate()
  const { pageState, authenticate, setError } = usePasskey()

  const isLoading = pageState !== 'idle'

  const handleSelectSigner = async () => {
    try {
      const success = await authenticate()
      if (success) {
        navigate('/passkey/pair/invite')
      }
      // Note: authenticate() already sets error via context on failure,
      // so no need to set error here when success is false
    } catch (err) {
      console.error('Authentication failed:', err)
      setError(err instanceof Error ? err.message : 'Authentication failed unexpectedly')
    }
  }

  const handleSelectInitiator = () => {
    navigate('/passkey/pair/request')
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

      <div className="p-4 rounded-lg border">
        <h3 className="font-medium flex items-center gap-2">
          <Key className="h-4 w-4" />
          Pair with Someone
        </h3>
        <p className="text-sm text-muted-foreground mt-2">
          Choose what you want to do to create a pairing key.
        </p>

        <div className="grid gap-3 mt-4">
          <Button
            onClick={handleSelectSigner}
            className="h-auto py-4 flex flex-col items-start gap-1"
            variant="outline"
            disabled={isLoading}
          >
            {pageState === 'getting_key' ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Authenticating...</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 font-semibold">
                  <Plus className="h-5 w-5" />
                  I want to pair with someone
                </div>
                <p className="text-xs text-muted-foreground font-normal text-left whitespace-normal">
                  Share your invite code first, then confirm their pairing request
                </p>
              </>
            )}
          </Button>

          <Button
            onClick={handleSelectInitiator}
            className="h-auto py-4 flex flex-col items-start gap-1"
            variant="outline"
            disabled={isLoading}
          >
            <div className="flex items-center gap-2 font-semibold">
              <CheckCircle2 className="h-5 w-5" />
              I have someone&apos;s invite code
            </div>
            <p className="text-xs text-muted-foreground font-normal text-left">
              Create a pairing request for them to confirm
            </p>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground text-center pt-4">
          Already have a pairing key?{' '}
          <Link to="/passkey/verify" className="text-primary hover:underline">
            Verify it here
          </Link>
        </p>
      </div>
    </div>
  )
}
