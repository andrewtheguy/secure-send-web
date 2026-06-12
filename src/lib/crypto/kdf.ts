import {
  AES_KEY_LENGTH,
  PBKDF2_HASH,
  PBKDF2_ITERATIONS,
  SALT_LENGTH,
} from './constants';
import { wipeBufferSource } from './memory';

export type PinKeyLabel = 'metadata' | 'signals' | 'p2p-content';

export interface NostrTransferKeys {
  metadata: CryptoKey;
  signals: CryptoKey;
  p2pContent: CryptoKey;
}

const PIN_KEY_LABEL_CONTEXT = 'secure-send:pin-key:v1';

const PIN_KEY_LABELS = {
  metadata: 'metadata',
  signals: 'signals',
  p2pContent: 'p2p-content',
} as const satisfies Record<keyof NostrTransferKeys, PinKeyLabel>;

/**
 * Import a PIN into non-extractable PBKDF2 key material.
 * The TextEncoder output is wiped after import to avoid lingering plaintext bytes.
 *
 * SECURITY IMPACT: If pinData is exposed in memory, an attacker can derive the
 * same PBKDF2 keys and decrypt PIN-protected transfers.
 * Scope note: PIN-derived keys are session-scoped and typically expire (~1 hour),
 * so exposure risk is bounded to that TTL window, but still high within it.
 *
 * Cleanup note: this only clears the temporary encoded bytes. The original PIN
 * string is managed by the JS engine and cannot be explicitly wiped.
 */
export async function importPinKey(pin: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const pinData = encoder.encode(pin);

  try {
    return await crypto.subtle.importKey('raw', pinData, 'PBKDF2', false, [
      'deriveBits',
      'deriveKey',
    ]);
  } finally {
    wipeBufferSource(pinData);
  }
}

function labeledSalt(salt: Uint8Array, label: PinKeyLabel): Uint8Array {
  if (salt.length < SALT_LENGTH) {
    throw new Error(
      `Salt too short: expected at least ${SALT_LENGTH} bytes, got ${salt.length}`,
    );
  }

  const labelBytes = new TextEncoder().encode(
    `${PIN_KEY_LABEL_CONTEXT}:${label}`,
  );
  const combined = new Uint8Array(salt.length + 1 + labelBytes.length);
  combined.set(salt, 0);
  combined[salt.length] = 0;
  combined.set(labelBytes, salt.length + 1);
  return combined;
}

/**
 * Derive an AES-256 key for a specific Nostr PIN-mode purpose.
 *
 * The transfer salt stays public and shared, but each purpose appends a stable
 * domain-separation label before PBKDF2 so metadata, relay signals/ACKs, and P2P
 * content never reuse the same AES-GCM key.
 */
export async function deriveLabeledKeyFromPinKey(
  keyMaterial: CryptoKey,
  salt: Uint8Array,
  label: PinKeyLabel,
): Promise<CryptoKey> {
  const saltWithLabel = labeledSalt(salt, label);

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltWithLabel as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive all Nostr PIN-mode keys from already-imported PIN key material.
 */
export async function deriveNostrTransferKeysFromPinKey(
  keyMaterial: CryptoKey,
  salt: Uint8Array,
): Promise<NostrTransferKeys> {
  const [metadata, signals, p2pContent] = await Promise.all([
    deriveLabeledKeyFromPinKey(keyMaterial, salt, PIN_KEY_LABELS.metadata),
    deriveLabeledKeyFromPinKey(keyMaterial, salt, PIN_KEY_LABELS.signals),
    deriveLabeledKeyFromPinKey(keyMaterial, salt, PIN_KEY_LABELS.p2pContent),
  ]);

  return {
    metadata,
    signals,
    p2pContent,
  };
}

/**
 * Generate random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * Derive all Nostr PIN-mode keys from a PIN.
 */
export async function deriveNostrTransferKeysFromPin(
  pin: string,
  salt: Uint8Array,
): Promise<NostrTransferKeys> {
  const keyMaterial = await importPinKey(pin);
  return deriveNostrTransferKeysFromPinKey(keyMaterial, salt);
}
