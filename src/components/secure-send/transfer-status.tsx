import { useState } from 'react'
import { Loader2, CheckCircle2, XCircle, Radio, ChevronDown, ChevronRight } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { TransferState } from '@/lib/nostr'
import { formatFileSize } from '@/lib/file-utils'

interface TransferStatusProps {
  state: TransferState
  betweenProgressAndChunks?: React.ReactNode
}

export function TransferStatus({ state, betweenProgressAndChunks }: TransferStatusProps) {
  const [showDebug, setShowDebug] = useState(false)

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

  // Show relays whenever Nostr was used (for debugging), regardless of P2P or cloud transfer
  const showRelays = state.currentRelays && state.currentRelays.length > 0

  return (
    <div className="space-y-3">
      <Alert variant={getVariant()}>
        {getIcon()}
        <AlertDescription>
          {state.message || state.status}
          {state.useWebRTC && (
            <span className="text-xs text-muted-foreground ml-2">(P2P)</span>
          )}
        </AlertDescription>
      </Alert>

      {showRelays && (
        <div className="text-xs space-y-1">
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDebug ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>Debug info</span>
          </button>
          {showDebug && (
            <div className="pl-4 space-y-1">
              <p className="font-medium text-muted-foreground">
                Connected Relays: {state.currentRelays!.length}
                {state.totalRelays !== undefined && ` / ${state.totalRelays}`}
              </p>
              <ul className="space-y-0.5 pl-3">
                {state.currentRelays!.map((relay, idx) => (
                  <li key={idx} className="text-muted-foreground truncate" title={relay}>
                    • {relay.replace('wss://', '')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {state.progress && state.progress.total > 0 && (
        <div className="space-y-1">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground text-right">
            {formatFileSize(state.progress.current)} / {formatFileSize(state.progress.total)}
          </p>
        </div>
      )}

      {betweenProgressAndChunks}
    </div>
  )
}
