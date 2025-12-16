import { CheckCircle2, Circle, Loader2, Send } from 'lucide-react'
import type { ChunkState, ChunkStatus } from '@/lib/nostr/types'

interface ChunkProgressProps {
  chunks: Map<number, ChunkState>
  mode: 'send' | 'receive'
}

function getStatusLabel(status: ChunkStatus, mode: 'send' | 'receive') {
  if (mode === 'send') {
    switch (status) {
      case 'pending':
        return 'Pending'
      case 'sending':
        return 'Sending'
      case 'sent':
        return 'Sent (waiting for ACK)'
      case 'acked':
        return 'ACKed'
      default:
        return 'Unknown'
    }
  } else {
    switch (status) {
      case 'pending':
        return 'Waiting'
      case 'receiving':
        return 'Receiving'
      case 'received':
        return 'Received'
      default:
        return 'Unknown'
    }
  }
}

function getStatusColor(status: ChunkStatus, mode: 'send' | 'receive') {
  if (mode === 'send') {
    switch (status) {
      case 'pending':
        return 'bg-muted text-muted-foreground'
      case 'sending':
        return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
      case 'sent':
        return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
      case 'acked':
        return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
      default:
        return 'bg-muted text-muted-foreground'
    }
  } else {
    switch (status) {
      case 'pending':
        return 'bg-muted text-muted-foreground'
      case 'receiving':
        return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
      case 'received':
        return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
      default:
        return 'bg-muted text-muted-foreground'
    }
  }
}

function getStatusIcon(status: ChunkStatus, mode: 'send' | 'receive') {
  if (mode === 'send') {
    switch (status) {
      case 'pending':
        return <Circle className="h-4 w-4" />
      case 'sending':
        return <Loader2 className="h-4 w-4 animate-spin" />
      case 'sent':
        return <Send className="h-4 w-4" />
      case 'acked':
        return <CheckCircle2 className="h-4 w-4" />
      default:
        return <Circle className="h-4 w-4" />
    }
  } else {
    switch (status) {
      case 'pending':
        return <Circle className="h-4 w-4" />
      case 'receiving':
        return <Loader2 className="h-4 w-4 animate-spin" />
      case 'received':
        return <CheckCircle2 className="h-4 w-4" />
      default:
        return <Circle className="h-4 w-4" />
    }
  }
}

export function ChunkProgress({ chunks, mode }: ChunkProgressProps) {
  const sortedChunks = Array.from(chunks.values()).sort((a, b) => a.seq - b.seq)
  const total = sortedChunks.length

  // Find the current active chunk (first non-completed chunk)
  // For send: first chunk that isn't 'acked'
  // For receive: first chunk that isn't 'received'
  const completedStatus = mode === 'send' ? 'acked' : 'received'
  const activeChunk = sortedChunks.find(c => c.status !== completedStatus)

  // Count completed chunks
  const completed = sortedChunks.filter(c => c.status === completedStatus).length

  // If no active chunk, show the last chunk (all done)
  const displayChunk = activeChunk || sortedChunks[sortedChunks.length - 1]

  if (!displayChunk) return null

  // 1-indexed display
  const displayNumber = displayChunk.seq + 1

  return (
    <div className="space-y-2">
      {/* Summary line */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Chunk Progress</span>
        <span>{completed}/{total} {mode === 'send' ? 'ACKed' : 'Received'}</span>
      </div>

      {/* Current chunk display */}
      <div className={`flex items-center gap-3 p-3 rounded-lg ${getStatusColor(displayChunk.status, mode)}`}>
        {getStatusIcon(displayChunk.status, mode)}
        <div className="flex-1">
          <div className="font-medium">
            Chunk {displayNumber} of {total}
          </div>
          <div className="text-xs opacity-80">
            {getStatusLabel(displayChunk.status, mode)}
            {(displayChunk.retries ?? 0) > 0 && (
              <span className="ml-1 text-orange-600 dark:text-orange-400">
                ({displayChunk.retries} {displayChunk.retries === 1 ? 'retry' : 'retries'})
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
