import {
  type Event,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { TRANSFER_EXPIRATION_MS } from '../crypto/constants';
import { EVENT_KIND_DATA_TRANSFER, EVENT_KIND_PIN_EXCHANGE } from './types';

/**
 * Generate ephemeral keypair for a transfer
 */
export function generateEphemeralKeys(): {
  secretKey: Uint8Array;
  publicKey: string;
} {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/**
 * Create PIN exchange event (kind 24243)
 * Contains encrypted payload with transfer metadata.
 *
 * @param hint - Time-bucketed event-filtering tag: one-way PBKDF2-SHA256 derivation of the PIN (first 16 hex chars), salted with the current hourly bucket; see computePinHint
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
  hint: string,
): Event {
  // Soft TTL: relays may auto-delete after this timestamp (NIP-40)
  const expiration = Math.floor((Date.now() + TRANSFER_EXPIRATION_MS) / 1000);

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
    secretKey,
  );

  return event;
}

/**
 * Parse PIN exchange event tags.
 * @returns Object with hint (one-way PBKDF2 PIN derivation), salt, transferId, and encryptedPayload
 */
export function parsePinExchangeEvent(event: Event): {
  hint: string;
  salt: Uint8Array;
  transferId: string;
  encryptedPayload: Uint8Array;
} | null {
  if (event.kind !== EVENT_KIND_PIN_EXCHANGE) return null;

  const hint = event.tags.find((t) => t[0] === 'h')?.[1];
  const saltB64 = event.tags.find((t) => t[0] === 's')?.[1];
  const transferId = event.tags.find((t) => t[0] === 't')?.[1];

  if (!hint || !saltB64 || !transferId) return null;

  return {
    hint,
    salt: base64ToUint8Array(saltB64),
    transferId,
    encryptedPayload: base64ToUint8Array(event.content),
  };
}

function createAckEvent(
  secretKey: Uint8Array,
  senderPubkey: string,
  transferId: string,
  seq: number,
  content: string,
  hint?: string,
): Event {
  const tags: string[][] = [
    ['p', senderPubkey],
    ['t', transferId],
    ['seq', seq.toString()],
    ['type', 'ack'],
  ];

  // Add hint tag if provided (one-way PBKDF2 PIN derivation, for event correlation/debugging)
  if (hint) {
    tags.push(['h', hint]);
  }

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey,
  );

  return event;
}

/**
 * Create ACK event (kind 24242) with PIN-authenticated encrypted content.
 * The current protocol emits seq=0 for the receiver ready ACK. Transfer
 * completion is confirmed later with an ACK on the WebRTC data channel.
 *
 * Tags remain plaintext so relays can filter by transfer and sequence, but the
 * sender MUST verify that the encrypted body repeats the same transfer/sequence.
 * This proves the ACK author knows the PIN-derived session key; a public
 * transferId alone is not enough to mark the receiver ready.
 *
 * hint is optional - used to confirm which PIN exchange event was processed
 * (event correlation/debugging); it carries no key-selection meaning in PIN-only mode.
 */
export async function createAuthenticatedAckEvent(
  secretKey: Uint8Array,
  senderPubkey: string,
  transferId: string,
  seq: number,
  key: CryptoKey,
  hint?: string,
): Promise<Event> {
  const payload = {
    type: 'ack',
    transferId,
    seq,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const encryptedPayload = await encrypt(key, payloadBytes);
  return createAckEvent(
    secretKey,
    senderPubkey,
    transferId,
    seq,
    uint8ArrayToBase64(encryptedPayload),
    hint,
  );
}

/**
 * Parse ACK event
 */
export function parseAckEvent(event: Event): {
  senderPubkey: string;
  transferId: string;
  seq: number;
  hint?: string;
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null;

  const type = event.tags.find((t) => t[0] === 'type')?.[1];
  if (type !== 'ack') return null;

  const senderPubkey = event.tags.find((t) => t[0] === 'p')?.[1];
  const transferId = event.tags.find((t) => t[0] === 't')?.[1];
  const seqStr = event.tags.find((t) => t[0] === 'seq')?.[1];
  const hint = event.tags.find((t) => t[0] === 'h')?.[1];

  if (!senderPubkey || !transferId || !seqStr) return null;

  const seq = parseInt(seqStr, 10);

  // Validate: seq must be an integer in the protocol ACK range.
  if (!Number.isInteger(seq) || seq < -1) return null;

  return { senderPubkey, transferId, seq, hint };
}

/**
 * Verify that an ACK event body is encrypted with the session key and matches
 * its plaintext routing tags.
 */
export async function verifyAuthenticatedAckEvent(
  event: Event,
  key: CryptoKey,
  expectedTransferId: string,
  expectedSeq: number,
): Promise<boolean> {
  const ack = parseAckEvent(event);
  if (!ack) return false;
  if (ack.transferId !== expectedTransferId || ack.seq !== expectedSeq)
    return false;
  if (!event.content) return false;

  try {
    const decrypted = await decrypt(key, base64ToUint8Array(event.content));
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
    if (!payload || typeof payload !== 'object') return false;

    const p = payload as Record<string, unknown>;
    if (p.type !== 'ack') return false;
    if (p.transferId !== ack.transferId) return false;
    if (p.seq !== ack.seq) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Create Signaling event (kind 24242 with type=signal)
 */
export function createSignalingEvent(
  secretKey: Uint8Array,
  senderPubkey: string,
  transferId: string,
  encryptedSignal: Uint8Array,
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
    secretKey,
  );
  return event;
}

/**
 * Parse Signaling event
 */
export function parseSignalingEvent(event: Event): {
  transferId: string;
  senderPubkey: string;
  encryptedSignal: Uint8Array;
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null;

  const type = event.tags.find((t) => t[0] === 'type')?.[1];
  if (type !== 'signal') return null;

  const transferId = event.tags.find((t) => t[0] === 't')?.[1];
  const senderPubkey = event.tags.find((t) => t[0] === 'p')?.[1];

  if (!transferId || !senderPubkey) return null;

  try {
    const encryptedSignal = base64ToUint8Array(event.content);
    return { transferId, senderPubkey, encryptedSignal };
  } catch {
    return null;
  }
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
