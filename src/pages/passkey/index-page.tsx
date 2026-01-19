import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function PasskeyIndexPage() {
  return (
    <div className="space-y-6">
      {/* Create New Passkey */}
      <Link to="/passkey/create" className="block">
        <div className="p-4 rounded-lg border-2 border-primary/30 bg-primary/5 hover:border-primary/50 hover:bg-primary/10 transition-colors">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Create New Passkey
          </h3>
          <p className="text-sm text-muted-foreground mt-2">
            Create a passkey to securely send files to yourself across devices without needing PINs.
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
