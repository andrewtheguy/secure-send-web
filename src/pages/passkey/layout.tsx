import { Outlet } from 'react-router-dom'
import { Fingerprint, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PasskeyProvider, usePasskey } from '@/contexts/passkey-context'

function PasskeyAlerts() {
  const { error, success } = usePasskey()

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-green-500/50 bg-green-50/50 dark:bg-green-950/20">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertTitle className="text-green-600">Success</AlertTitle>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}
    </>
  )
}

function TechnicalDetails() {
  return (
    <div className="text-xs text-muted-foreground space-y-1 border-t pt-4">
      <p>
        <span className="font-medium text-foreground">How it works:</span> Your passkey derives a
        non-extractable master key via the WebAuthn PRF extension. A shareable public ID and
        fingerprint are derived with HKDF. Transfers use ephemeral ECDH session keys plus
        passkey-bound session binding, ensuring only the intended recipient can decrypt.
      </p>
      <p>
        <span className="font-medium text-foreground">Self-transfer:</span> Passkeys sync across
        your devices via your password manager, allowing PIN-free transfers to yourself without
        sharing any codes.
      </p>
    </div>
  )
}

function PasskeyLayoutContent() {
  return (
    <div className="flex w-full justify-center">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-2xl flex items-center gap-2">
            <Fingerprint className="h-6 w-6" />
            Passkey Setup
          </CardTitle>
          <CardDescription>
            Create a passkey for secure, PIN-free file transfers to yourself
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <PasskeyAlerts />
          <Outlet />
          <TechnicalDetails />
        </CardContent>
      </Card>
    </div>
  )
}

export function PasskeyLayout() {
  return (
    <PasskeyProvider>
      <PasskeyLayoutContent />
    </PasskeyProvider>
  )
}
