import pako from 'pako'
import type { ContentType } from './nostr/types'

/**
 * QR Signaling Payload - exchanged via QR codes between sender and receiver
 */
export interface QRSignalingPayload {
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
 * Encode bytes to ASCII string using Latin-1 (ISO-8859-1)
 * Each byte maps to a character 0x00-0xFF
 * More compact than base64 for QR byte mode
 */
function bytesToLatin1(bytes: Uint8Array): string {
  let result = ''
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i])
  }
  return result
}

/**
 * Decode Latin-1 string back to bytes
 */
function latin1ToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i)
  }
  return bytes
}

/**
 * Compress signaling payload for QR code
 * Uses JSON + gzip compression + Latin-1 encoding (more compact than base64)
 */
export function compressSignalingData(payload: QRSignalingPayload): string {
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  // Use Latin-1 encoding (1 byte = 1 char) instead of base64 (33% overhead)
  return bytesToLatin1(compressed)
}

/**
 * Decompress signaling payload from QR code data
 */
export function decompressSignalingData(compressed: string): QRSignalingPayload {
  const bytes = latin1ToBytes(compressed)
  const decompressed = pako.ungzip(bytes, { to: 'string' })
  return JSON.parse(decompressed) as QRSignalingPayload
}

/**
 * Generate offer QR data
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
): string {
  const payload: QRSignalingPayload = {
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
  return compressSignalingData(payload)
}

/**
 * Generate answer QR data
 */
export function generateAnswerQRData(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[]
): string {
  const payload: QRSignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map(c => c.candidate),
  }
  return compressSignalingData(payload)
}

/**
 * Parse QR payload data
 * Returns null if invalid
 */
export function parseQRPayload(data: string): QRSignalingPayload | null {
  try {
    return decompressSignalingData(data)
  } catch {
    return null
  }
}

/**
 * Validate QR payload structure
 */
export function isValidQRPayload(payload: unknown): payload is QRSignalingPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (p.type !== 'offer' && p.type !== 'answer') return false
  if (typeof p.sdp !== 'string') return false
  if (!Array.isArray(p.candidates)) return false
  return true
}

/**
 * Estimate compressed size of payload (for UI feedback)
 */
export function estimateCompressedSize(payload: QRSignalingPayload): number {
  const compressed = compressSignalingData(payload)
  return compressed.length
}

/**
 * Max QR code capacity for alphanumeric data (version 40, L error correction)
 * In practice we use ~3KB limit for reliable scanning
 */
export const MAX_QR_DATA_SIZE = 3000

/**
 * Check if payload fits in QR code
 */
export function fitsInQRCode(payload: QRSignalingPayload): boolean {
  return estimateCompressedSize(payload) <= MAX_QR_DATA_SIZE
}
