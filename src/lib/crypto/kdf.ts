import { AES_KEY_LENGTH, SALT_LENGTH } from './constants';

/**
 * Session keys for Auto Exchange (Nostr) mode, derived from the ephemeral ECDH
 * shared secret established during the PIN-authenticated handshake. The PIN
 * itself derives none of these — see importPinRoot in pin.ts.
 */
export interface NostrSessionKeys {
  /** Encrypts relay-carried WebRTC signaling (offer/answer/candidates). */
  signals: CryptoKey;
  /** Encrypts P2P file content chunks on the data channel. */
  content: CryptoKey;
}

const SESSION_KEY_LABELS = {
  signals: 'secure-send:nostr-session:v2:signals',
  content: 'secure-send:nostr-session:v2:content',
} as const satisfies Record<keyof NostrSessionKeys, string>;

async function deriveSessionKey(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  if (salt.length < SALT_LENGTH) {
    throw new Error(
      `Salt too short: expected at least ${SALT_LENGTH} bytes, got ${salt.length}`,
    );
  }

  const encoder = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: encoder.encode(info),
    },
    sharedSecretKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive the Auto Exchange session keys from the non-extractable HKDF key
 * returned by deriveSharedSecretKey (ecdh.ts) and the public per-transfer salt.
 * Distinct HKDF info labels guarantee signaling and content never reuse the
 * same AES-GCM key.
 */
export async function deriveNostrSessionKeys(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
): Promise<NostrSessionKeys> {
  const [signals, content] = await Promise.all([
    deriveSessionKey(sharedSecretKey, salt, SESSION_KEY_LABELS.signals),
    deriveSessionKey(sharedSecretKey, salt, SESSION_KEY_LABELS.content),
  ]);

  return { signals, content };
}

/**
 * Generate random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return salt;
}
