import { Link } from 'react-router-dom'
import { Plus, Key, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function PasskeyIndexPage() {
  return (
    <div className="space-y-6">
      {/* Create New Passkey */}
      <Link to="/passkey/create" className="block">
        <div className="p-4 rounded-lg border-2 border-primary/30 bg-primary/5 hover:border-primary/50 hover:bg-primary/10 transition-colors cursor-pointer">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Create New Passkey
          </h3>
          <p className="text-sm text-muted-foreground mt-2">
            Create a passkey to generate your invite code. Share it with peers for secure file
            transfers without needing PINs.
          </p>
        </div>
      </Link>

      {/* Already Have a Passkey */}
      <Link to="/passkey/pair" className="block">
        <div className="p-4 rounded-lg border hover:border-primary/30 hover:bg-muted/50 transition-colors cursor-pointer">
          <h3 className="font-medium flex items-center gap-2">
            <Key className="h-4 w-4" />
            Already Have a Passkey?
          </h3>
          <p className="text-sm text-muted-foreground mt-2">
            Pair with someone to create a shared pairing key for secure transfers.
          </p>
        </div>
      </Link>

      {/* Verify Pairing Key */}
      <Link to="/passkey/verify" className="block">
        <div className="p-4 rounded-lg border hover:border-primary/30 hover:bg-muted/50 transition-colors cursor-pointer">
          <h3 className="font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Verify Pairing Key
          </h3>
          <p className="text-sm text-muted-foreground mt-2">
            Verify a pairing key&apos;s authenticity by checking the digital signatures.
          </p>
        </div>
      </Link>

      <div className="pt-4">
        <Button variant="outline" asChild className="w-full">
          <Link to="/">Back to Send</Link>
        </Button>
      </div>
    </div>
  )
}
