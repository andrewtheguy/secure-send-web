import { CheckCircle2, Circle, Loader2, Send, AlertCircle } from 'lucide-react'
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
        return 'Sent'
      case 'acked':
        return 'ACKed'
      default:
        return 'Unknown'
    }
  } else {
    switch (status) {
      case 'pending':
        return 'Pending'
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

export function ChunkProgress({ chunks, mode }: ChunkProgressProps) {
  const sortedChunks = Array.from(chunks.values()).sort((a, b) => a.seq - b.seq)

  // Count chunks by status
  const statusCounts = sortedChunks.reduce((acc, chunk) => {
    acc[chunk.status] = (acc[chunk.status] || 0) + 1
    return acc
  }, {} as Record<ChunkStatus, number>)

  // Calculate summary stats
  const total = sortedChunks.length
  const completed = mode === 'send'
    ? (statusCounts.acked || 0)
    : (statusCounts.received || 0)
  const inProgress = mode === 'send'
    ? (statusCounts.sending || 0) + (statusCounts.sent || 0)
    : (statusCounts.receiving || 0)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">Chunk Details</span>
        <span className="text-muted-foreground">
          {completed}/{total} {mode === 'send' ? 'ACKed' : 'Received'}
          {inProgress > 0 && ` (${inProgress} in progress)`}
        </span>
      </div>

      {/* Status Summary */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {mode === 'send' ? (
          <>
            <div className="flex items-center gap-1.5">
              <Circle className="h-3 w-3 text-muted-foreground" />
              <span>Pending: {statusCounts.pending || 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 text-blue-500" />
              <span>Sending: {statusCounts.sending || 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Send className="h-3 w-3 text-yellow-500" />
              <span>Sent: {statusCounts.sent || 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              <span>ACKed: {statusCounts.acked || 0}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <Circle className="h-3 w-3 text-muted-foreground" />
              <span>Pending: {statusCounts.pending || 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 text-blue-500" />
              <span>Receiving: {statusCounts.receiving || 0}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              <span>Received: {statusCounts.received || 0}</span>
            </div>
          </>
        )}
      </div>

      {/* Chunk Grid */}
      <div className="border rounded-lg p-3 bg-muted/30">
        <div className="grid grid-cols-8 sm:grid-cols-12 md:grid-cols-16 gap-1">
          {sortedChunks.map((chunk) => (
            <div
              key={chunk.seq}
              className={`
                flex items-center justify-center
                h-8 w-8 rounded
                text-[10px] font-medium
                ${getStatusColor(chunk.status, mode)}
                ${chunk.retries && chunk.retries > 0 ? 'ring-2 ring-orange-500' : ''}
              `}
              title={`Chunk ${chunk.seq}: ${getStatusLabel(chunk.status, mode)}${chunk.retries ? ` (${chunk.retries} retries)` : ''}`}
            >
              {chunk.seq}
            </div>
          ))}
        </div>
        {sortedChunks.some(c => c.retries && c.retries > 0) && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-orange-600 dark:text-orange-400">
            <AlertCircle className="h-3 w-3" />
            <span>Orange ring indicates retries</span>
          </div>
        )}
      </div>
    </div>
  )
}
