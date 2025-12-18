import pako from 'pako'
import type { ContentType } from './nostr/types'

/**
 * QR Signaling Format Version
 *
 * IMPORTANT: If you change the minified format in a backwards-incompatible way,
 * you must use a new PIN first character (e.g., "3" instead of "2") to ensure
 * old clients don't try to parse new format data.
 *
 * Current version uses PIN prefix "2" (defined in crypto/constants.ts)
 */
const QR_FORMAT_VERSION = 1

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
 * Minified internal payload format for QR compression
 * Uses short keys to reduce JSON size before gzip
 */
interface MinifiedPayload {
  v: number      // version
  t: 'o' | 'a'   // type: offer/answer
  s: string      // sdp
  c: string[]    // candidates (minified)
  // Offer-only fields:
  x?: string     // salt as hex string (was number[], now compact)
  ct?: 'f' | 't' // contentType: file/text (was full string)
  fn?: string    // fileName
  fs?: number    // fileSize
  mt?: string    // mimeType
  tb?: number    // totalBytes
}

/**
 * Minify ICE candidate string by removing redundant data
 *
 * Input:  "candidate:738418781 1 udp 2122063615 10.22.34.100 59067 typ host generation 0 ufrag cZ5M network-id 1"
 * Output: "candidate:738418781 1 udp 2122063615 10.22.34.100 59067 typ host"
 *
 * Removed:
 * - "generation 0" - always 0, assumed on both sides
 * - "ufrag XXXX" - already in SDP, redundant
 * - "network-id N" - not needed for connection establishment
 */
function minifyCandidate(candidate: string): string {
  return candidate
    .replace(/ generation \d+/g, '')
    .replace(/ ufrag \S+/g, '')
    .replace(/ network-id \d+/g, '')
    .trim()
}

/**
 * Expand minified candidate back to full format
 * Adds back "generation 0" which is required by WebRTC
 */
function expandCandidate(minified: string): string {
  // Add "generation 0" at the end if not present
  if (!minified.includes(' generation ')) {
    return minified + ' generation 0'
  }
  return minified
}

/**
 * Convert byte array to base64 string (more compact than hex)
 * 16 bytes → 24 chars (base64) vs 32 chars (hex)
 */
function bytesToBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Convert base64 string back to byte array
 */
function base64ToBytes(b64: string): number[] {
  const binary = atob(b64)
  const bytes: number[] = []
  for (let i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i))
  }
  return bytes
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convert base64 string to Uint8Array
 */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Convert full payload to minified format
 */
function minifyPayload(payload: QRSignalingPayload): MinifiedPayload {
  const minified: MinifiedPayload = {
    v: QR_FORMAT_VERSION,
    t: payload.type === 'offer' ? 'o' : 'a',
    s: payload.sdp,
    c: payload.candidates.map(minifyCandidate),
  }

  // Add optional offer fields with compact encoding
  if (payload.salt) minified.x = bytesToBase64(payload.salt) // [1,2,3...] → base64
  if (payload.contentType) minified.ct = payload.contentType === 'file' ? 'f' : 't'
  if (payload.fileName) minified.fn = payload.fileName
  if (payload.fileSize !== undefined) minified.fs = payload.fileSize
  if (payload.mimeType) minified.mt = payload.mimeType
  if (payload.totalBytes !== undefined) minified.tb = payload.totalBytes

  return minified
}

/**
 * Convert minified format back to full payload
 */
function expandPayload(minified: MinifiedPayload): QRSignalingPayload {
  const payload: QRSignalingPayload = {
    type: minified.t === 'o' ? 'offer' : 'answer',
    sdp: minified.s,
    candidates: minified.c.map(expandCandidate),
  }

  // Add optional offer fields with expansion
  if (minified.x) payload.salt = base64ToBytes(minified.x) // base64 → [1,2,3...]
  if (minified.ct) payload.contentType = minified.ct === 'f' ? 'file' : 'text'
  if (minified.fn) payload.fileName = minified.fn
  if (minified.fs !== undefined) payload.fileSize = minified.fs
  if (minified.mt) payload.mimeType = minified.mt
  if (minified.tb !== undefined) payload.totalBytes = minified.tb

  return payload
}

/**
 * Compress signaling payload for QR code
 * Uses minified JSON + gzip compression + base64 encoding
 * Base64 is used for consistency - same format for QR display and clipboard
 */
export function compressSignalingData(payload: QRSignalingPayload): string {
  const minified = minifyPayload(payload)
  const json = JSON.stringify(minified)
  const compressed = pako.gzip(json)
  return uint8ArrayToBase64(compressed)
}

/**
 * Decompress signaling payload from QR code data (base64 encoded)
 */
export function decompressSignalingData(base64Data: string): QRSignalingPayload {
  const bytes = base64ToUint8Array(base64Data)
  const decompressed = pako.ungzip(bytes, { to: 'string' })
  const minified = JSON.parse(decompressed) as MinifiedPayload
  return expandPayload(minified)
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
