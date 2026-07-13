export interface ReceivedFile {
  contentType: 'file';
  /**
   * Received plaintext, backed by an OPFS scratch file so reading/downloading
   * streams from disk.
   */
  data: Blob;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export type ReceivedContent = ReceivedFile;

/**
 * Key material derived from an entered PIN.
 * @property key - Non-extractable HKDF PIN root (see importPinRoot): the full
 *   PBKDF2 stretch of the PIN, from which the receiver derives the per-bucket
 *   rendezvous hints, the rendezvous payload key, and the claim/confirm auth
 *   key. It derives no content-encryption keys — those come from the ephemeral
 *   ECDH exchange the PIN authenticates.
 * @property fingerprint - Stable PIN fingerprint (see computePinFingerprintFromRoot),
 *   shown for human visual comparison only; never sent across the wire.
 */
export interface PinKeyMaterial {
  key: CryptoKey;
  fingerprint: string;
}
