import pako from 'pako'
import type { ContentType } from './nostr/types'

// Magic header: "SS02" = Secure Send version 2 (ECDH mutual exchange)
const MAGIC_HEADER_V2 = new Uint8Array([0x53, 0x53, 0x30, 0x32])

/**
 * Signaling Payload - method-agnostic format for Manual Exchange mode
 * Used by both QR scan and copy/paste methods
 */
export interface SignalingPayload {
  type: 'offer' | 'answer'
  sdp: string
  candidates: string[] // ICE candidates as SDP strings
  // Milliseconds since epoch when this payload was generated (TTL enforced by receiver for offers).
  createdAt: number
  // ECDH public key for mutual exchange (65 bytes P-256 uncompressed)
  publicKey?: number[]
  // Offer-only fields:
  contentType?: ContentType
  fileName?: string
  fileSize?: number
  mimeType?: string
  totalBytes?: number
  salt?: number[] // Salt for content encryption key derivation (from ECDH shared secret)
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Parse binary QR data
 * Returns the raw binary payload (pass-through)
 */
export function parseBinaryQRPayload(bytes: Uint8Array): Uint8Array {
  return bytes
}

/**
 * Parse base64 clipboard data to binary payload
 */
export function parseClipboardPayload(base64: string): Uint8Array | null {
  try {
    return base64ToUint8Array(base64)
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
 * Validate binary payload has correct magic header (SS02)
 */
export function isValidBinaryPayload(binary: Uint8Array): boolean {
  return isMutualPayload(binary)
}

/**
 * Estimate compressed payload size in bytes
 */
export function estimatePayloadSize(payload: SignalingPayload): number {
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  return compressed.length
}

/**
 * Generate mutual offer as binary data
 * Format: [SS02 magic (4 bytes)][compressed payload]
 * NOT encrypted - ECDH public keys are not secret
 */
export function generateMutualOfferBinary(
  offer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  metadata: {
    createdAt: number
    contentType: ContentType
    totalBytes: number
    fileName?: string
    fileSize?: number
    mimeType?: string
    publicKey: Uint8Array // ECDH public key (65 bytes)
    salt: Uint8Array // Salt for AES key derivation
  }
): Uint8Array {
  const payload: SignalingPayload = {
    type: 'offer',
    sdp: offer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    createdAt: metadata.createdAt,
    contentType: metadata.contentType,
    totalBytes: metadata.totalBytes,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
    publicKey: Array.from(metadata.publicKey),
    salt: Array.from(metadata.salt),
  }

  const encoder = new TextEncoder()
  const jsonBytes = encoder.encode(JSON.stringify(payload))
  const compressed = pako.deflate(jsonBytes)

  // Build binary: [SS02][compressed]
  const result = new Uint8Array(4 + compressed.length)
  result.set(MAGIC_HEADER_V2, 0)
  result.set(compressed, 4)
  return result
}

/**
 * Generate mutual answer as binary data
 * Format: [SS02 magic (4 bytes)][compressed payload]
 */
export function generateMutualAnswerBinary(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  publicKey: Uint8Array // ECDH public key (65 bytes)
): Uint8Array {
  const payload: SignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    createdAt: Date.now(),
    publicKey: Array.from(publicKey),
  }

  const encoder = new TextEncoder()
  const jsonBytes = encoder.encode(JSON.stringify(payload))
  const compressed = pako.deflate(jsonBytes)

  // Build binary: [SS02][compressed]
  const result = new Uint8Array(4 + compressed.length)
  result.set(MAGIC_HEADER_V2, 0)
  result.set(compressed, 4)
  return result
}

/**
 * Parse mutual exchange binary payload (offer or answer)
 * Returns null if invalid format or version
 */
export function parseMutualPayload(binary: Uint8Array): SignalingPayload | null {
  try {
    // Verify magic header "SS02"
    if (
      binary.length < 5 ||
      binary[0] !== 0x53 ||
      binary[1] !== 0x53 ||
      binary[2] !== 0x30 ||
      binary[3] !== 0x32
    ) {
      return null
    }

    const compressed = binary.slice(4)
    const jsonBytes = pako.inflate(compressed)
    const json = new TextDecoder().decode(jsonBytes)
    const payload = JSON.parse(json)

    if (!isValidSignalingPayload(payload)) {
      return null
    }

    // Validate publicKey is present for mutual exchange
    if (!payload.publicKey || !Array.isArray(payload.publicKey)) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

/**
 * Check if binary payload is mutual exchange format (SS02)
 */
export function isMutualPayload(binary: Uint8Array): boolean {
  return (
    binary.length > 4 &&
    binary[0] === 0x53 &&
    binary[1] === 0x53 &&
    binary[2] === 0x30 &&
    binary[3] === 0x32
  )
}

/**
 * Generate base64 string for clipboard (mutual exchange)
 */
export function generateMutualClipboardData(binary: Uint8Array): string {
  return uint8ArrayToBase64(binary)
}
