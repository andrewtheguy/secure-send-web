import pako from 'pako'
import { base45Encode, base45Decode } from './base45'
import type { ContentType } from './nostr/types'

/**
 * Signaling Payload - method-agnostic format for the pipeline
 * Used by both QR and copy/paste modes
 */
export interface SignalingPayload {
  type: 'offer' | 'answer'
  sdp: string
  candidates: string[] // ICE candidates as SDP strings
  // Offer-only fields:
  salt?: number[] // Encryption salt for key derivation
  contentType?: ContentType
  fileName?: string
  fileSize?: number
  mimeType?: string
  totalBytes?: number
}

// Keep old name as alias for compatibility during migration
export type QRSignalingPayload = SignalingPayload

/**
 * QR chunk format constants
 * Format: X/Y:data$
 * - X: chunk index (1-9)
 * - Y: total chunks (1-9)
 * - data: base45 encoded gzipped JSON
 * - $: end marker for integrity check
 */
const HEADER_SIZE = 4  // "X/Y:"
const END_MARKER_SIZE = 1  // "$"
const MAX_CHUNKS = 9
export const MAX_QR_CHUNK_SIZE = 1000  // chars per QR code

/**
 * Generate offer QR data as array of chunks
 * Returns array of QR-ready strings in format: X/Y:base45data$
 */
export function generateOfferQRData(
  offer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  salt: Uint8Array,
  metadata: {
    contentType: ContentType
    totalBytes: number
    fileName?: string
    fileSize?: number
    mimeType?: string
  }
): string[] {
  const payload: SignalingPayload = {
    type: 'offer',
    sdp: offer.sdp || '',
    candidates: candidates.map(c => c.candidate),
    salt: Array.from(salt),
    contentType: metadata.contentType,
    totalBytes: metadata.totalBytes,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
  }
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  const base45Data = base45Encode(new Uint8Array(compressed))
  return splitQRData(base45Data)
}

/**
 * Generate answer QR data as array of chunks
 */
export function generateAnswerQRData(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[]
): string[] {
  const payload: SignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map(c => c.candidate),
  }
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  const base45Data = base45Encode(new Uint8Array(compressed))
  return splitQRData(base45Data)
}

/**
 * Generate raw JSON for clipboard (no encoding)
 */
export function generateClipboardData(payload: SignalingPayload): string {
  return JSON.stringify(payload)
}

/**
 * Parse base45-encoded QR data to SignalingPayload
 * Used after merging multi-QR chunks
 */
export function parseQRPayload(base45Data: string): SignalingPayload | null {
  try {
    const compressed = base45Decode(base45Data)
    const json = pako.ungzip(compressed, { to: 'string' })
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Parse raw JSON to SignalingPayload (for paste tab)
 */
export function parseJSONPayload(json: string): SignalingPayload | null {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Split base45 data into QR chunks with fixed-length header
 * Format: X/Y:data$
 */
export function splitQRData(base45Data: string): string[] {
  const chunkDataSize = MAX_QR_CHUNK_SIZE - HEADER_SIZE - END_MARKER_SIZE

  if (base45Data.length <= chunkDataSize) {
    return [`1/1:${base45Data}$`]
  }

  const numChunks = Math.ceil(base45Data.length / chunkDataSize)
  if (numChunks > MAX_CHUNKS) {
    throw new Error(`Payload too large: would need ${numChunks} QR codes (max ${MAX_CHUNKS})`)
  }

  const chunks: string[] = []
  for (let i = 0; i < base45Data.length; i += chunkDataSize) {
    chunks.push(base45Data.slice(i, i + chunkDataSize))
  }
  return chunks.map((chunk, i) => `${i + 1}/${chunks.length}:${chunk}$`)
}

/**
 * Parse a QR chunk with fixed 4-char header "X/Y:" and trailing "$"
 * Returns null if format is invalid (corrupt data)
 */
export function parseQRChunk(data: string): { index: number; total: number; data: string } | null {
  // Validate format: X/Y:...$ (min length 6: "1/1:x$")
  if (data.length < 6 || data[1] !== '/' || data[3] !== ':' || data[data.length - 1] !== '$') {
    return null  // Corrupt or invalid format
  }
  const index = parseInt(data[0])
  const total = parseInt(data[2])
  if (isNaN(index) || isNaN(total) || index < 1 || total < 1 || index > total || total > MAX_CHUNKS) {
    return null
  }
  const payload = data.slice(4, -1)  // Skip 4-char header, remove trailing $
  return { index, total, data: payload }
}

/**
 * Merge QR chunks back together
 * Returns the combined base45 data or null if incomplete/invalid
 */
export function mergeQRChunks(chunks: string[]): string | null {
  if (chunks.length === 0) return null

  const parsed = chunks.map(parseQRChunk).filter((c): c is NonNullable<typeof c> => c !== null)
  if (parsed.length === 0) return null

  const total = parsed[0].total
  if (parsed.length !== total) return null  // Incomplete

  // Validate all chunks have same total
  if (!parsed.every(p => p.total === total)) return null

  // Sort by index and merge
  parsed.sort((a, b) => a.index - b.index)

  // Verify sequential indices
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].index !== i + 1) return null
  }

  return parsed.map(p => p.data).join('')
}

/**
 * Validate SignalingPayload structure
 */
export function isValidSignalingPayload(payload: unknown): payload is SignalingPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (p.type !== 'offer' && p.type !== 'answer') return false
  if (typeof p.sdp !== 'string') return false
  if (!Array.isArray(p.candidates)) return false
  return true
}

// Keep old name as alias for compatibility
export const isValidQRPayload = isValidSignalingPayload

/**
 * Estimate number of QR codes needed for a payload
 */
export function estimateQRCount(payload: SignalingPayload): number {
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  const base45Data = base45Encode(new Uint8Array(compressed))
  const chunkDataSize = MAX_QR_CHUNK_SIZE - HEADER_SIZE - END_MARKER_SIZE
  return Math.ceil(base45Data.length / chunkDataSize)
}

/**
 * Max QR code data size (legacy export for compatibility)
 */
export const MAX_QR_DATA_SIZE = MAX_QR_CHUNK_SIZE
