import { describe, expect, test } from 'vitest';
import {
  PIN_CHARSET,
  PIN_FINGERPRINT_LENGTH,
  PIN_HINT_LENGTH,
  PIN_LENGTH,
} from './constants';
import {
  computePinFingerprintFromRoot,
  computePinHintFromRoot,
  derivePinAuthKey,
  derivePinRendezvousKey,
  formatPin,
  generatePin,
  importPinRoot,
  isValidPin,
  normalizePinInput,
} from './pin';

describe('PIN Utilities', () => {
  test('generatePin produces a valid PIN from the Crockford charset', () => {
    const pin = generatePin();
    expect(pin).toHaveLength(PIN_LENGTH);
    expect([...pin].every((char) => PIN_CHARSET.includes(char))).toBe(true);
    expect(isValidPin(pin)).toBe(true);
  });

  test('checksum detects any single-character substitution', () => {
    const pin = generatePin();
    for (let i = 0; i < PIN_LENGTH - 1; i++) {
      const original = pin[i];
      const replacement =
        PIN_CHARSET[(PIN_CHARSET.indexOf(original) + 1) % PIN_CHARSET.length];
      const mutated = pin.slice(0, i) + replacement + pin.slice(i + 1);
      expect(isValidPin(mutated)).toBe(false);
    }
  });

  test('checksum detects typical adjacent transpositions', () => {
    // Deterministic example: distinct adjacent data chars whose alphabet
    // positions do not differ by 16 (the only undetected distance).
    const data = '012345678';
    const pin = data + computeChecksumForTest(data);
    expect(isValidPin(pin)).toBe(true);
    const swapped = `10${pin.slice(2)}`;
    expect(isValidPin(swapped)).toBe(false);
  });

  test('normalizePinInput uppercases, maps look-alikes, strips separators', () => {
    expect(normalizePinInput('ab cd-e')).toBe('ABCDE');
    expect(normalizePinInput('oO')).toBe('00');
    expect(normalizePinInput('iIlL')).toBe('1111');
    // Invalid characters are preserved for the caller to detect
    expect(normalizePinInput('u!')).toBe('U!');
  });

  test('formatPin groups symmetrically', () => {
    expect(formatPin('ABCDE12345')).toBe('ABCDE-12345');
  });

  test('importPinRoot returns a non-extractable HKDF key', async () => {
    const root = await importPinRoot(generatePin());
    expect(root.extractable).toBe(false);
    expect(root.algorithm.name).toBe('HKDF');
  });

  test('hint is deterministic per bucket and differs across buckets and PINs', async () => {
    const pin = generatePin();
    const root = await importPinRoot(pin);

    const current = await computePinHintFromRoot(root, 0);
    expect(current).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`));
    expect(await computePinHintFromRoot(root, 0)).toBe(current);

    const previous = await computePinHintFromRoot(root, 1);
    expect(previous).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`));
    expect(previous).not.toBe(current);

    const otherRoot = await importPinRoot(generatePin());
    expect(await computePinHintFromRoot(otherRoot, 0)).not.toBe(current);
  });

  test('fingerprint is stable and domain-separated from the hint', async () => {
    const root = await importPinRoot(generatePin());
    const fp = await computePinFingerprintFromRoot(root);
    expect(fp).toMatch(new RegExp(`^[0-9a-f]{${PIN_FINGERPRINT_LENGTH}}$`));
    expect(await computePinFingerprintFromRoot(root)).toBe(fp);
    expect(fp).not.toBe(await computePinHintFromRoot(root, 0));
  });

  test('auth and rendezvous keys are distinct non-extractable AES keys', async () => {
    const root = await importPinRoot(generatePin());
    const authKey = await derivePinAuthKey(root);
    const rendezvousKey = await derivePinRendezvousKey(root);

    for (const key of [authKey, rendezvousKey]) {
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe('AES-GCM');
    }

    // Domain separation: a payload sealed with one key must not open with the other
    const plaintext = new TextEncoder().encode('payload');
    const { encrypt, decrypt } = await import('./aes-gcm');
    const sealed = await encrypt(authKey, plaintext);
    await expect(decrypt(rendezvousKey, sealed)).rejects.toThrow();
  });

  test('two peers derive identical values from the same PIN', async () => {
    const pin = generatePin();
    const senderRoot = await importPinRoot(pin);
    const receiverRoot = await importPinRoot(pin);

    expect(await computePinHintFromRoot(receiverRoot, 0)).toBe(
      await computePinHintFromRoot(senderRoot, 0),
    );
    expect(await computePinFingerprintFromRoot(receiverRoot)).toBe(
      await computePinFingerprintFromRoot(senderRoot),
    );

    const { encrypt, decrypt } = await import('./aes-gcm');
    const sealed = await encrypt(
      await derivePinAuthKey(senderRoot),
      new TextEncoder().encode('proof'),
    );
    const opened = await decrypt(await derivePinAuthKey(receiverRoot), sealed);
    expect(new TextDecoder().decode(opened)).toBe('proof');
  });
});

/** Mirror of the internal position-weighted checksum, for test vectors. */
function computeChecksumForTest(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += PIN_CHARSET.indexOf(data[i]) * (2 * i + 1);
  }
  return PIN_CHARSET[sum % PIN_CHARSET.length];
}
