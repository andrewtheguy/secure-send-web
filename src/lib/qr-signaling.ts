import pako from 'pako'
import type { ContentType } from './nostr/types'
import { deriveKeyFromPin, encrypt, decrypt, generateSalt } from './crypto'

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

export interface EncryptedSignalingPayload {
  v: 1
  salt: string
  payload: string
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

export async function encryptSignalingPayload(
  payload: SignalingPayload,
  pin: string
): Promise<EncryptedSignalingPayload> {
  const encoder = new TextEncoder()
  const payloadBytes = encoder.encode(JSON.stringify(payload))
  const salt = generateSalt()
  const key = await deriveKeyFromPin(pin, salt)
  const encrypted = await encrypt(key, payloadBytes)

  return {
    v: 1,
    salt: uint8ArrayToBase64(salt),
    payload: uint8ArrayToBase64(encrypted),
  }
}

export async function decryptSignalingPayload(
  encryptedPayload: EncryptedSignalingPayload,
  pin: string
): Promise<SignalingPayload | null> {
  try {
    const salt = base64ToUint8Array(encryptedPayload.salt)
    const encrypted = base64ToUint8Array(encryptedPayload.payload)
    const key = await deriveKeyFromPin(pin, salt)
    const plaintext = await decrypt(key, encrypted)
    const json = new TextDecoder().decode(plaintext)
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Generate offer as binary data (gzipped JSON)
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
    candidates: candidates.map(c => c.candidate),
    contentType: metadata.contentType,
    totalBytes: metadata.totalBytes,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
  }
  const encryptedPayload = await encryptSignalingPayload(payload, pin)
  const json = JSON.stringify(encryptedPayload)
  return pako.gzip(json)
}

/**
 * Generate answer as binary data (gzipped JSON)
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
    candidates: candidates.map(c => c.candidate),
  }
  const encryptedPayload = await encryptSignalingPayload(payload, pin)
  const json = JSON.stringify(encryptedPayload)
  return pako.gzip(json)
}

/**
 * Parse binary QR data (gzipped JSON) to EncryptedSignalingPayload
 */
export function parseBinaryQRPayload(bytes: Uint8Array): EncryptedSignalingPayload | null {
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
export function generateClipboardData(payload: EncryptedSignalingPayload): string {
  return JSON.stringify(payload)
}

/**
 * Parse raw JSON to EncryptedSignalingPayload (for paste tab)
 */
export function parseJSONPayload(json: string): EncryptedSignalingPayload | null {
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

export function isValidEncryptedSignalingPayload(payload: unknown): payload is EncryptedSignalingPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (p.v !== 1) return false
  if (typeof p.salt !== 'string') return false
  if (typeof p.payload !== 'string') return false
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
