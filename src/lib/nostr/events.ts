import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { EVENT_KIND_PIN_EXCHANGE, EVENT_KIND_DATA_TRANSFER, type ChunkNotifyPayload } from './types'
import { TRANSFER_EXPIRATION_MS } from '../crypto/constants'

/**
 * Generate ephemeral keypair for a transfer
 */
export function generateEphemeralKeys(): { secretKey: Uint8Array; publicKey: string } {
  const secretKey = generateSecretKey()
  const publicKey = getPublicKey(secretKey)
  return { secretKey, publicKey }
}

/**
 * Create PIN exchange event (kind 24243)
 * Contains encrypted payload with transfer metadata.
 *
 * @param hint - Identifier for event filtering. Can be either:
 *   - PIN mode: SHA-256 hash of user's PIN (first 8 hex chars)
 *   - Passkey mode: Passkey fingerprint (11 base36 chars from credential ID)
 *
 * TTL Behavior:
 * - Events include an 'expiration' tag set to 1 hour from creation (NIP-40)
 * - NIP-40 compliant relays MAY auto-delete events after expiration
 * - Sender enforces TTL by refusing to start transfer after expiration
 * - Receiver enforces TTL by refusing to ACK/establish sessions for expired events
 */
export function createPinExchangeEvent(
  secretKey: Uint8Array,
  encryptedPayload: Uint8Array,
  salt: Uint8Array,
  transferId: string,
  hint: string
): Event {
  // Soft TTL: relays may auto-delete after this timestamp (NIP-40)
  const expiration = Math.floor((Date.now() + TRANSFER_EXPIRATION_MS) / 1000)

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_PIN_EXCHANGE,
      content: uint8ArrayToBase64(encryptedPayload),
      tags: [
        ['h', hint],
        ['s', uint8ArrayToBase64(salt)],
        ['t', transferId],
        ['type', 'pin_exchange'],
        ['expiration', expiration.toString()],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  )

  return event
}

/**
 * Parse PIN exchange event tags.
 * @returns Object with hint (PIN hash or passkey fingerprint), salt, transferId, and encryptedPayload
 */
export function parsePinExchangeEvent(event: Event): {
  hint: string
  salt: Uint8Array
  transferId: string
  encryptedPayload: Uint8Array
} | null {
  if (event.kind !== EVENT_KIND_PIN_EXCHANGE) return null

  const hint = event.tags.find((t) => t[0] === 'h')?.[1]
  const saltB64 = event.tags.find((t) => t[0] === 's')?.[1]
  const transferId = event.tags.find((t) => t[0] === 't')?.[1]

  if (!hint || !saltB64 || !transferId) return null

  return {
    hint,
    salt: base64ToUint8Array(saltB64),
    transferId,
    encryptedPayload: base64ToUint8Array(event.content),
  }
}

/**
 * Create Mutual Trust exchange event (kind 24243)
 * Used for passkey-based mutual trust mode where both parties exchange public keys.
 *
 * @param secretKey - Nostr ephemeral secret key
 * @param encryptedPayload - AES-GCM encrypted transfer metadata
 * @param salt - Per-transfer salt for key derivation
 * @param transferId - Unique transfer identifier
 * @param receiverFingerprint - Receiver's public key fingerprint (for event filtering)
 * @param senderFingerprint - Sender's public key fingerprint (for verification)
 * @param keyConfirmHash - Hash of HKDF-derived key confirmation value (MITM detection)
 * @param receiverPkCommitment - Hash of receiver's public key (relay MITM prevention)
 * @param nonce - Base64-encoded 16-byte random nonce (replay protection)
 */
export function createMutualTrustEvent(
  secretKey: Uint8Array,
  encryptedPayload: Uint8Array,
  salt: Uint8Array,
  transferId: string,
  receiverFingerprint: string,
  senderFingerprint: string,
  keyConfirmHash: string,
  receiverPkCommitment: string,
  nonce: string
): Event {
  const expiration = Math.floor((Date.now() + TRANSFER_EXPIRATION_MS) / 1000)

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_PIN_EXCHANGE,
      content: uint8ArrayToBase64(encryptedPayload),
      tags: [
        ['h', receiverFingerprint], // For receiver to find the event
        ['spk', senderFingerprint], // Sender's public key fingerprint for verification
        ['kc', keyConfirmHash], // Key confirmation hash (MITM detection)
        ['rpkc', receiverPkCommitment], // Receiver public key commitment (relay MITM prevention)
        ['n', nonce], // Replay nonce (16 bytes, base64)
        ['s', uint8ArrayToBase64(salt)],
        ['t', transferId],
        ['type', 'mutual_trust'],
        ['expiration', expiration.toString()],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  )

  return event
}

/**
 * Parse Mutual Trust event tags.
 * @returns Object with receiver/sender fingerprints, security tags, salt, transferId, and encryptedPayload
 */
export function parseMutualTrustEvent(event: Event): {
  receiverFingerprint: string
  senderFingerprint: string
  keyConfirmHash: string
  receiverPkCommitment: string
  nonce: string
  salt: Uint8Array
  transferId: string
  encryptedPayload: Uint8Array
} | null {
  if (event.kind !== EVENT_KIND_PIN_EXCHANGE) return null

  const type = event.tags.find((t) => t[0] === 'type')?.[1]
  if (type !== 'mutual_trust') return null

  const receiverFingerprint = event.tags.find((t) => t[0] === 'h')?.[1]
  const senderFingerprint = event.tags.find((t) => t[0] === 'spk')?.[1]
  const keyConfirmHash = event.tags.find((t) => t[0] === 'kc')?.[1]
  const receiverPkCommitment = event.tags.find((t) => t[0] === 'rpkc')?.[1]
  const nonceB64 = event.tags.find((t) => t[0] === 'n')?.[1]
  const saltB64 = event.tags.find((t) => t[0] === 's')?.[1]
  const transferId = event.tags.find((t) => t[0] === 't')?.[1]

  if (!receiverFingerprint || !senderFingerprint || !keyConfirmHash ||
      !receiverPkCommitment || !nonceB64 || !saltB64 || !transferId) return null

  // Validate nonce: must be valid base64 and decode to exactly 16 bytes
  let nonceBytes: Uint8Array
  try {
    nonceBytes = base64ToUint8Array(nonceB64)
    if (nonceBytes.length !== 16) {
      return null
    }
  } catch {
    return null
  }

  // Validate salt: must be valid base64
  let salt: Uint8Array
  try {
    salt = base64ToUint8Array(saltB64)
    if (salt.length < 16) {
      return null
    }
  } catch {
    return null
  }

  // Validate encrypted payload: must be valid base64
  let encryptedPayload: Uint8Array
  try {
    encryptedPayload = base64ToUint8Array(event.content)
  } catch {
    return null
  }

  return {
    receiverFingerprint,
    senderFingerprint,
    keyConfirmHash,
    receiverPkCommitment,
    nonce: nonceB64,
    salt,
    transferId,
    encryptedPayload,
  }
}

/**
 * Create ACK event (kind 24242)
 * seq=0 for ready ACK, seq=-1 for completion ACK
 * hint is optional - used in dual mode to indicate which key the receiver used
 * nonce is optional - echoed from sender's mutual trust event for replay protection
 */
export function createAckEvent(
  secretKey: Uint8Array,
  senderPubkey: string,
  transferId: string,
  seq: number,
  hint?: string,
  nonce?: string
): Event {
  const tags: string[][] = [
    ['p', senderPubkey],
    ['t', transferId],
    ['seq', seq.toString()],
    ['type', 'ack'],
  ]

  // Add hint tag if provided (for dual mode key selection)
  if (hint) {
    tags.push(['h', hint])
  }

  // Add nonce tag for replay protection (echoed from sender's mutual trust event)
  if (nonce) {
    tags.push(['n', nonce])
  }

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  )

  return event
}

/**
 * Parse ACK event
 */
export function parseAckEvent(event: Event): {
  senderPubkey: string
  transferId: string
  seq: number
  hint?: string
  nonce?: string
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null

  const type = event.tags.find((t) => t[0] === 'type')?.[1]
  if (type !== 'ack') return null

  const senderPubkey = event.tags.find((t) => t[0] === 'p')?.[1]
  const transferId = event.tags.find((t) => t[0] === 't')?.[1]
  const seqStr = event.tags.find((t) => t[0] === 'seq')?.[1]
  const hint = event.tags.find((t) => t[0] === 'h')?.[1]
  const nonce = event.tags.find((t) => t[0] === 'n')?.[1]

  if (!senderPubkey || !transferId || !seqStr) return null

  const seq = parseInt(seqStr, 10)

  // Validate: seq must be integer, valid values are -1 (complete), 0 (ready), or > 0 (chunk ack)
  if (!Number.isInteger(seq) || seq < -1) return null

  return { senderPubkey, transferId, seq, hint, nonce }
}

/**
 * Create Signaling event (kind 24242 with type=signal)
 */
export function createSignalingEvent(
  secretKey: Uint8Array,
  senderPubkey: string,
  transferId: string,
  encryptedSignal: Uint8Array
): Event {
  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: uint8ArrayToBase64(encryptedSignal),
      tags: [
        ['t', transferId],
        ['p', senderPubkey],
        ['type', 'signal'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  )
  return event
}

/**
 * Parse Signaling event
 */
export function parseSignalingEvent(event: Event): {
  transferId: string
  senderPubkey: string
  encryptedSignal: Uint8Array
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null

  const type = event.tags.find((t) => t[0] === 'type')?.[1]
  if (type !== 'signal') return null

  const transferId = event.tags.find((t) => t[0] === 't')?.[1]
  const senderPubkey = event.tags.find((t) => t[0] === 'p')?.[1]

  if (!transferId || !senderPubkey) return null

  try {
    const encryptedSignal = base64ToUint8Array(event.content)
    return { transferId, senderPubkey, encryptedSignal }
  } catch {
    return null
  }
}

/**
 * Create Chunk Notification event (kind 24242 with type=chunk_notify)
 * Sent by sender to notify receiver of an uploaded chunk URL (cloud fallback)
 */
export function createChunkNotifyEvent(
  secretKey: Uint8Array,
  receiverPubkey: string,
  transferId: string,
  chunkIndex: number,
  totalChunks: number,
  chunkUrl: string,
  chunkSize: number
): Event {
  const payload: ChunkNotifyPayload = {
    transferId,
    chunkIndex,
    totalChunks,
    chunkUrl,
    chunkSize,
  }

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: JSON.stringify(payload),
      tags: [
        ['p', receiverPubkey],
        ['t', transferId],
        ['type', 'chunk_notify'],
        ['chunk', chunkIndex.toString()],
        ['total', totalChunks.toString()],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  )
  return event
}

/**
 * Parse Chunk Notification event
 */
export function parseChunkNotifyEvent(event: Event): ChunkNotifyPayload | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null

  const type = event.tags.find((t) => t[0] === 'type')?.[1]
  if (type !== 'chunk_notify') return null

  try {
    const payload = JSON.parse(event.content) as ChunkNotifyPayload
    // Validate required fields
    if (
      typeof payload.transferId !== 'string' ||
      typeof payload.chunkIndex !== 'number' ||
      typeof payload.totalChunks !== 'number' ||
      typeof payload.chunkUrl !== 'string' ||
      typeof payload.chunkSize !== 'number'
    ) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
