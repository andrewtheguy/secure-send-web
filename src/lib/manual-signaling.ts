import pako from 'pako'

// Magic header: "SS02" = Secure Send version 2 (ECDH mutual exchange)
const MAGIC_HEADER_V2 = new Uint8Array([0x53, 0x53, 0x30, 0x32])
const BUCKET_SEC = 3600 // 1 hour
const BASE_SEED = 0x9e3779b9

function getSeedForBucket(bucketEpoch: number): number {
  // Simple hash of bucket index
  let h = BASE_SEED ^ bucketEpoch
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

function xorshift32(state: number): number {
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return state >>> 0
}

/**
 * the goal of obfuscation is simply to avoid casual inspection
 */
function xorObfuscate(data: Uint8Array, seed: number): Uint8Array {
  let state = seed
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    state = xorshift32(state)
    out[i] = data[i] ^ (state & 0xff)
  }
  return out
}

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
  publicKey: number[]
  // Offer-only fields:
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
  if (!(p.candidates as unknown[]).every((c) => typeof c === 'string')) return false
  if (typeof p.createdAt !== 'number') return false
  if (!Array.isArray(p.publicKey)) return false
  return true
}

/**
 * Validate binary payload has correct magic header (SS02)
 */
export function isValidBinaryPayload(binary: Uint8Array): boolean {
  return isMutualPayload(binary)
}

/**
 * Estimate compressed payload size in bytes (includes SS02 magic header)
 */
export function estimatePayloadSize(payload: SignalingPayload): number {
  const json = JSON.stringify(payload)
  const compressed = pako.deflate(json)
  return 4 + compressed.length // 4 bytes for SS02 magic header
}

/**
 * Generate mutual offer as binary data
 * Format: [SS02 magic (4 bytes)][obfuscated compressed payload]
 * NOT encrypted - ECDH public keys are not secret
 */
export function generateMutualOfferBinary(
  offer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  metadata: {
    createdAt: number
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

  const currentBucket = Math.floor(Date.now() / 1000 / BUCKET_SEC)
  const seed = getSeedForBucket(currentBucket)
  return xorObfuscate(result, seed)
}

/**
 * Generate mutual answer as binary data
 * Format: [SS02 magic (4 bytes)][obfuscated compressed payload]
 */
export function generateMutualAnswerBinary(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  publicKey: Uint8Array, // ECDH public key (65 bytes)
  createdAt: number = Date.now()
): Uint8Array {
  const payload: SignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    createdAt,
    publicKey: Array.from(publicKey),
  }

  const encoder = new TextEncoder()
  const jsonBytes = encoder.encode(JSON.stringify(payload))
  const compressed = pako.deflate(jsonBytes)

  // Build binary: [SS02][compressed]
  const result = new Uint8Array(4 + compressed.length)
  result.set(MAGIC_HEADER_V2, 0)
  result.set(compressed, 4)

  const currentBucket = Math.floor(Date.now() / 1000 / BUCKET_SEC)
  const seed = getSeedForBucket(currentBucket)
  return xorObfuscate(result, seed)
}

/**
 * Validate publicKey is a valid P-256 uncompressed public key (65 bytes, values 0-255)
 */
function isValidPublicKeyArray(arr: unknown): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== 65) return false
  return arr.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)
}

/**
 * Parse mutual exchange binary payload (offer or answer)
 * Returns null if invalid format or version
 */
export function parseMutualPayload(binary: Uint8Array): SignalingPayload | null {
  try {
    if (binary.length <= 4) {
      return null
    }

    const currentBucket = Math.floor(Date.now() / 1000 / BUCKET_SEC)

    // Try current and previous 3 buckets (approx 4 hours window)
    for (let i = 0; i <= 3; i++) {
      try {
        const seed = getSeedForBucket(currentBucket - i)

        // Optimization: check magic header first
        const head = xorObfuscate(binary.subarray(0, 4), seed)
        if (
          head[0] !== MAGIC_HEADER_V2[0] ||
          head[1] !== MAGIC_HEADER_V2[1] ||
          head[2] !== MAGIC_HEADER_V2[2] ||
          head[3] !== MAGIC_HEADER_V2[3]
        ) {
          continue
        }

        const deobfuscated = xorObfuscate(binary, seed)
        const compressed = deobfuscated.slice(4)
        const jsonBytes = pako.inflate(compressed)
        const json = new TextDecoder().decode(jsonBytes)
        const payload = JSON.parse(json)

        if (isValidSignalingPayload(payload)) {
          if (typeof payload.createdAt === 'number' && Number.isFinite(payload.createdAt)) {
            // Validate publicKey is a valid P-256 uncompressed key (65 bytes)
            if (isValidPublicKeyArray(payload.publicKey)) {
              return payload
            }
          }
        }
      } catch {
        // Continue to next bucket if this one fails
        continue
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Check if binary payload is mutual exchange format (SS02)
 */
export function isMutualPayload(binary: Uint8Array): boolean {
  return binary.length > 4
}

/**
 * Generate base64 string for clipboard (mutual exchange)
 */
export function generateMutualClipboardData(binary: Uint8Array): string {
  return uint8ArrayToBase64(binary)
}
