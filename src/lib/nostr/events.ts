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
 */
export function createPinExchangeEvent(
  secretKey: Uint8Array,
  encryptedPayload: Uint8Array,
  salt: Uint8Array,
  transferId: string,
  pinHint: string
): Event {
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

  return {
    transferId,
    seq: parseInt(seqStr, 10),
    total: parseInt(totalStr, 10),
    data: base64ToUint8Array(event.content),
  }
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

  return {
    senderPubkey,
    transferId,
    seq: parseInt(seqStr, 10),
  }
}

// Utility functions for base64 encoding/decoding
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
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
