import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex w-full justify-center">
      <div className="w-full max-w-2xl rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted p-2">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
            <p className="text-sm text-muted-foreground">
              The page you tried to reach doesn’t exist or was moved.
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-4 text-sm text-muted-foreground">
          <p>
            Check the URL or head back to Secure Send to start a transfer.
          </p>
          <div>
            <Button asChild>
              <Link to="/">Go to Send</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
