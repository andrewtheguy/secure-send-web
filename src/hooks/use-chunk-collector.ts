import { useState, useCallback, useRef } from 'react'
import { parseChunk, reassembleChunks, extractChunkParam } from '@/lib/chunk-utils'

interface ChunkCollectorState {
  totalChunks: number | null
  collectedCount: number
  collectedIndices: Set<number>
  isComplete: boolean
  assembledPayload: Uint8Array | null
}

export function useChunkCollector() {
  const chunksRef = useRef(new Map<number, Uint8Array>())
  const totalRef = useRef<number | null>(null)

  const [state, setState] = useState<ChunkCollectorState>({
    totalChunks: null,
    collectedCount: 0,
    collectedIndices: new Set<number>(),
    isComplete: false,
    assembledPayload: null,
  })

  const addChunk = useCallback((encoded: string): boolean => {
    const parsed = parseChunk(encoded)
    if (!parsed) return false

    // Reject chunks with mismatched total (guards against mixing different offers)
    if (totalRef.current !== null && parsed.total !== totalRef.current) {
      return false
    }

    // Ignore duplicates so re-scanning the same QR does not overwrite state.
    if (chunksRef.current.has(parsed.index)) {
      return false
    }

    totalRef.current = parsed.total
    chunksRef.current.set(parsed.index, parsed.data)

    const collectedCount = chunksRef.current.size
    const isComplete = collectedCount === parsed.total

    const collectedIndices = new Set(chunksRef.current.keys())

    if (isComplete) {
      const assembled = reassembleChunks(chunksRef.current, parsed.total)
      setState({
        totalChunks: parsed.total,
        collectedCount,
        collectedIndices,
        isComplete: true,
        assembledPayload: assembled,
      })
    } else {
      setState({
        totalChunks: parsed.total,
        collectedCount,
        collectedIndices,
        isComplete: false,
        assembledPayload: null,
      })
    }

    return true
  }, [])

  const addChunkFromUrl = useCallback((url: string): boolean => {
    const param = extractChunkParam(url)
    if (!param) return false
    return addChunk(param)
  }, [addChunk])

  return { state, addChunk, addChunkFromUrl }
}
