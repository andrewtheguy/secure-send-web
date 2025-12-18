import pako from 'pako'
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

/**
 * Generate offer as binary data (gzipped JSON)
 * Returns Uint8Array ready for binary QR code encoding
 */
export function generateOfferQRBinary(
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
): Uint8Array {
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
  return pako.gzip(json)
}

/**
 * Generate answer as binary data (gzipped JSON)
 * Returns Uint8Array ready for binary QR code encoding
 */
export function generateAnswerQRBinary(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[]
): Uint8Array {
  const payload: SignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map(c => c.candidate),
  }
  const json = JSON.stringify(payload)
  return pako.gzip(json)
}

/**
 * Parse binary QR data (gzipped JSON) to SignalingPayload
 */
export function parseBinaryQRPayload(bytes: Uint8Array): SignalingPayload | null {
  try {
    const json = pako.ungzip(bytes, { to: 'string' })
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Generate raw JSON for clipboard (no encoding)
 */
export function generateClipboardData(payload: SignalingPayload): string {
  return JSON.stringify(payload)
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

/**
 * Estimate compressed payload size in bytes
 */
export function estimatePayloadSize(payload: SignalingPayload): number {
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  return compressed.length
}
