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
 * Compress signaling payload for QR code
 * Uses gzip compression + base64 encoding
 */
export function compressSignalingData(payload: QRSignalingPayload): string {
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  // Convert to base64
  return btoa(String.fromCharCode(...compressed))
}

/**
 * Decompress signaling payload from QR code data
 */
export function decompressSignalingData(compressed: string): QRSignalingPayload {
  // Decode base64
  const binary = atob(compressed)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  // Decompress
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
