import pako from 'pako'
import type { ContentType } from './nostr/types'
import { deriveKeyFromPin, encrypt, decrypt, generateSalt } from './crypto'

// Magic header: "SS01" = Secure Send version 1
const MAGIC_HEADER = new Uint8Array([0x53, 0x53, 0x30, 0x31])

/**
 * Signaling Payload - method-agnostic format for the pipeline
 * Used by both QR and copy/paste modes
 */
export interface SignalingPayload {
  type: 'offer' | 'answer'
  sdp: string
  candidates: string[] // ICE candidates as SDP strings
  // Offer-only fields:
  contentType?: ContentType
  fileName?: string
  fileSize?: number
  mimeType?: string
  totalBytes?: number
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
 * Encrypt signaling payload to binary format
 * Format: [SS01 magic (4 bytes)][salt (16 bytes)][encrypted payload]
 */
export async function encryptSignalingPayload(
  payload: SignalingPayload,
  pin: string
): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const payloadBytes = encoder.encode(JSON.stringify(payload))
  const salt = generateSalt()
  const key = await deriveKeyFromPin(pin, salt)
  const encrypted = await encrypt(key, payloadBytes)

  // Build binary: [SS01][salt][encrypted]
  const result = new Uint8Array(4 + 16 + encrypted.length)
  result.set(MAGIC_HEADER, 0)
  result.set(salt, 4)
  result.set(encrypted, 20)
  return result
}

/**
 * Decrypt binary signaling payload
 * Expects format: [SS01 magic (4 bytes)][salt (16 bytes)][encrypted payload]
 */
export async function decryptSignalingPayload(
  binary: Uint8Array,
  pin: string
): Promise<SignalingPayload | null> {
  try {
    // Verify magic header "SS01"
    if (
      binary[0] !== 0x53 ||
      binary[1] !== 0x53 ||
      binary[2] !== 0x30 ||
      binary[3] !== 0x31
    ) {
      throw new Error('Invalid format or unsupported version')
    }
    const salt = binary.slice(4, 20)
    const encrypted = binary.slice(20)
    const key = await deriveKeyFromPin(pin, salt)
    const plaintext = await decrypt(key, encrypted)
    const json = new TextDecoder().decode(plaintext)
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Generate offer as binary data (gzipped binary payload)
 * Returns Uint8Array ready for binary QR code encoding
 */
export async function generateOfferQRBinary(
  offer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  metadata: {
    contentType: ContentType
    totalBytes: number
    fileName?: string
    fileSize?: number
    mimeType?: string
  },
  pin: string
): Promise<Uint8Array> {
  const payload: SignalingPayload = {
    type: 'offer',
    sdp: offer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    contentType: metadata.contentType,
    totalBytes: metadata.totalBytes,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
  }
  const binary = await encryptSignalingPayload(payload, pin)
  return pako.gzip(binary)
}

/**
 * Generate answer as binary data (gzipped binary payload)
 * Returns Uint8Array ready for binary QR code encoding
 */
export async function generateAnswerQRBinary(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  pin: string
): Promise<Uint8Array> {
  const payload: SignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
  }
  const binary = await encryptSignalingPayload(payload, pin)
  return pako.gzip(binary)
}

/**
 * Parse binary QR data (gzipped binary payload)
 * Returns the raw binary payload (ungzipped)
 */
export function parseBinaryQRPayload(bytes: Uint8Array): Uint8Array | null {
  try {
    return pako.ungzip(bytes)
  } catch {
    return null
  }
}

/**
 * Generate base64 string for clipboard (from binary payload)
 */
export async function generateClipboardData(
  payload: SignalingPayload,
  pin: string
): Promise<string> {
  const binary = await encryptSignalingPayload(payload, pin)
  return uint8ArrayToBase64(binary)
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
 * Validate binary payload has correct magic header
 */
export function isValidBinaryPayload(binary: Uint8Array): boolean {
  return (
    binary.length > 20 &&
    binary[0] === 0x53 &&
    binary[1] === 0x53 &&
    binary[2] === 0x30 &&
    binary[3] === 0x31
  )
}

/**
 * Estimate compressed payload size in bytes
 */
export function estimatePayloadSize(payload: SignalingPayload): number {
  const json = JSON.stringify(payload)
  const compressed = pako.gzip(json)
  return compressed.length
}
