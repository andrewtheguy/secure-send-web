import { useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePasskey } from '@/contexts/passkey-context'
import { InviteCodeDisplay } from '@/components/passkey'

export function PasskeyInvitePage() {
  const navigate = useNavigate()
  const { fingerprint, pageState, authenticate, resetAll, setError } = usePasskey()

  const isLoading = pageState !== 'idle'

  // Auto-authenticate if not already authenticated
  useEffect(() => {
    if (!fingerprint && pageState === 'idle') {
      authenticate()
        .then((success) => {
          if (!success) {
            // Note: authenticate() already sets error state internally on failure,
            // but we add a navigation-specific message for clarity
            setError('Authentication failed. Returning to pairing options.')
            navigate('/passkey/pair')
          }
        })
        .catch((err) => {
          console.error('Authentication failed:', err)
          const errorMessage = err instanceof Error ? err.message : 'Unknown error'
          setError(`Authentication failed: ${errorMessage}. Returning to pairing options.`)
          navigate('/passkey/pair')
        })
    }
  }, [fingerprint, pageState, authenticate, navigate, setError])

  const handleBack = () => {
    navigate('/passkey/pair')
  }

  const handleStartOver = () => {
    resetAll()
    navigate('/passkey/pair')
  }

  if (!fingerprint && isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">Authenticating...</p>
      </div>
    )
  }

  if (!fingerprint) {
    return null
  }

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleBack}
        className="text-muted-foreground"
        disabled={isLoading}
        aria-label="Go back to pairing options"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      {/* Step 1: Invite Code */}
      <InviteCodeDisplay stepNumber={1} />

      {/* Step 2: Instructions */}
      <div className="p-4 rounded-lg border border-muted bg-muted/30">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted-foreground/50 text-white text-sm font-medium">
            2
          </span>
          <span className="font-semibold text-muted-foreground">Wait for Pairing Request</span>
        </div>
        <p className="text-sm text-muted-foreground ml-8">
          Ask your peer to scan your invite code above and create a pairing request. They will
          send it back to you.
        </p>
      </div>

      {/* Continue to confirm */}
      <div className="flex justify-between items-center">
        <Button variant="outline" onClick={handleStartOver} disabled={isLoading}>
          Start Over
        </Button>
        <Button asChild>
          <Link to="/passkey/pair/confirm">
            Continue to Confirm
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  )
}
