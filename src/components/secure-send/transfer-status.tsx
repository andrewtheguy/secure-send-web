import { Loader2, CheckCircle2, XCircle, Radio } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { TransferState } from '@/lib/nostr'

interface TransferStatusProps {
  state: TransferState
}

export function TransferStatus({ state }: TransferStatusProps) {
  if (state.status === 'idle') return null

  const getIcon = () => {
    switch (state.status) {
      case 'connecting':
      case 'waiting_for_receiver':
      case 'transferring':
      case 'receiving':
        return <Loader2 className="h-4 w-4 animate-spin" />
      case 'complete':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />
      case 'error':
        return <XCircle className="h-4 w-4 text-destructive" />
      default:
        return <Radio className="h-4 w-4" />
    }
  }

  const getVariant = (): 'default' | 'destructive' => {
    return state.status === 'error' ? 'destructive' : 'default'
  }

  const progressPercent =
    state.progress && state.progress.total > 0
      ? (state.progress.current / state.progress.total) * 100
      : 0

  return (
    <div className="space-y-3">
      <Alert variant={getVariant()}>
        <div className="flex items-center gap-2">
          {getIcon()}
          <AlertDescription>{state.message || state.status}</AlertDescription>
        </div>
      </Alert>

      {state.progress && state.progress.total > 1 && (
        <div className="space-y-1">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground text-right">
            {state.progress.current} / {state.progress.total} chunks
          </p>
        </div>
      )}
    </div>
  )
}
