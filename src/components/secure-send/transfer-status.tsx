import { Loader2, CheckCircle2, XCircle, Radio } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { TransferState } from '@/lib/nostr'
import { ChunkProgress } from './chunk-progress'

interface TransferStatusProps {
  state: TransferState
  mode?: 'send' | 'receive'
}

export function TransferStatus({ state, mode = 'send' }: TransferStatusProps) {
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

  const showChunkDetails = state.chunks && state.chunks.size > 0 && !state.useWebRTC
  const showRelays = state.currentRelays && state.currentRelays.length > 0 && !state.useWebRTC

  return (
    <div className="space-y-3">
      <Alert variant={getVariant()}>
        {getIcon()}
        <AlertDescription>
          {state.message || state.status}
          {state.useWebRTC === false && state.chunks && state.chunks.size > 1 && (
            <span className="text-xs text-muted-foreground ml-2">(Relay mode)</span>
          )}
        </AlertDescription>
      </Alert>

      {showRelays && (
        <div className="text-xs space-y-1">
          <p className="font-medium text-muted-foreground">Active Relays:</p>
          <ul className="space-y-0.5 pl-3">
            {state.currentRelays!.map((relay, idx) => (
              <li key={idx} className="text-muted-foreground truncate" title={relay}>
                • {relay.replace('wss://', '')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.progress && state.progress.total > 1 && (
        <div className="space-y-1">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground text-right">
            {state.progress.current} / {state.progress.total} chunks
          </p>
        </div>
      )}

      {showChunkDetails && (
        <ChunkProgress chunks={state.chunks!} mode={mode} />
      )}
    </div>
  )
}
