import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { EVENT_KIND_PIN_EXCHANGE, EVENT_KIND_DATA_TRANSFER } from './types'
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
 * Contains encrypted payload with transfer metadata
 *
 * TTL Behavior:
 * - Events include an 'expiration' tag set to 1 hour from creation (NIP-40)
 * - NIP-40 compliant relays MAY auto-delete events after expiration
 * - Sender enforces TTL by rejecting receiver connections after expiration
 *   (checked in use-nostr-send.ts after receiving ready ACK)
 *
 * Note: Receiver-side expiration checks are not implemented since a modified
 * client could bypass them. The sender-side check provides hard enforcement
 * because the sender must be online to respond to the receiver.
 */
export function createPinExchangeEvent(
  secretKey: Uint8Array,
  encryptedPayload: Uint8Array,
  salt: Uint8Array,
  transferId: string,
  pinHint: string
): Event {
  // Soft TTL: relays may auto-delete after this timestamp (NIP-40)
  const expiration = Math.floor((Date.now() + TRANSFER_EXPIRATION_MS) / 1000)

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_PIN_EXCHANGE,
      content: uint8ArrayToBase64(encryptedPayload),
      tags: [
        ['h', pinHint],
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
 * Parse PIN exchange event tags
 */
export function parsePinExchangeEvent(event: Event): {
  pinHint: string
  salt: Uint8Array
  transferId: string
  encryptedPayload: Uint8Array
} | null {
  if (event.kind !== EVENT_KIND_PIN_EXCHANGE) return null

  const pinHint = event.tags.find((t) => t[0] === 'h')?.[1]
  const saltB64 = event.tags.find((t) => t[0] === 's')?.[1]
  const transferId = event.tags.find((t) => t[0] === 't')?.[1]

  if (!pinHint || !saltB64 || !transferId) return null

  return {
    pinHint,
    salt: base64ToUint8Array(saltB64),
    transferId,
    encryptedPayload: base64ToUint8Array(event.content),
  }
}

/**
 * Create data chunk event (kind 24242)
 */
export function createChunkEvent(
  secretKey: Uint8Array,
  transferId: string,
  seq: number,
  total: number,
  encryptedChunk: Uint8Array
): Event {
  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: uint8ArrayToBase64(encryptedChunk),
      tags: [
        ['t', transferId],
        ['seq', seq.toString()],
        ['total', total.toString()],
        ['type', 'chunk'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  )

  return event
}

/**
 * Parse chunk event
 */
export function parseChunkEvent(event: Event): {
  transferId: string
  seq: number
  total: number
  data: Uint8Array
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null

  const type = event.tags.find((t) => t[0] === 'type')?.[1]
  if (type !== 'chunk') return null

  const transferId = event.tags.find((t) => t[0] === 't')?.[1]
  const seqStr = event.tags.find((t) => t[0] === 'seq')?.[1]
  const totalStr = event.tags.find((t) => t[0] === 'total')?.[1]

  if (!transferId || !seqStr || !totalStr) return null

  const seq = parseInt(seqStr, 10)
  const total = parseInt(totalStr, 10)

  // Validate parsed integers
  if (!Number.isInteger(seq) || !Number.isInteger(total)) return null
  if (seq < 0 || total <= 0 || seq >= total) return null

  // Decode base64 content with error handling
  let data: Uint8Array
  try {
    data = base64ToUint8Array(event.content)
  } catch {
    return null
  }

  return { transferId, seq, total, data }
}

/**
 * Create ACK event (kind 24242)
 * seq=0 for ready ACK, seq=-1 for completion ACK
 */
export function createAckEvent(
  secretKey: Uint8Array,
  senderPubkey: string,
  transferId: string,
  seq: number
): Event {
  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: '',
      tags: [
        ['p', senderPubkey],
        ['t', transferId],
        ['seq', seq.toString()],
        ['type', 'ack'],
      ],
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
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null

  const type = event.tags.find((t) => t[0] === 'type')?.[1]
  if (type !== 'ack') return null

  const senderPubkey = event.tags.find((t) => t[0] === 'p')?.[1]
  const transferId = event.tags.find((t) => t[0] === 't')?.[1]
  const seqStr = event.tags.find((t) => t[0] === 'seq')?.[1]

  if (!senderPubkey || !transferId || !seqStr) return null

  const seq = parseInt(seqStr, 10)

  // Validate: seq must be integer, valid values are -1 (complete), 0 (ready), or > 0 (chunk ack)
  if (!Number.isInteger(seq) || seq < -1) return null

  return { senderPubkey, transferId, seq }
}

// Utility functions for base64 encoding/decoding
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
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
