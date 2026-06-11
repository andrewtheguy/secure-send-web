export interface ReceivedFile {
  contentType: 'file'
  data: Uint8Array
  fileName: string
  fileSize: number
  mimeType: string
}

export type ReceivedContent = ReceivedFile

/**
 * Key material derived from PIN authentication.
 * @property key - Non-extractable PBKDF2 key material imported from the PIN. Used to
 *   derive both the AES content key and the time-bucketed Nostr hint (see computePinHint).
 *   The receiver re-derives the current and previous bucket wire hints from this at query time.
 * @property fingerprint - Stable, time-independent PIN fingerprint (see computePinFingerprint),
 *   shown for human visual comparison only; never sent across the wire.
 */
export interface PinKeyMaterial {
  key: CryptoKey
  fingerprint: string
}
