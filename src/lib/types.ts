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
 * @property key - The derived CryptoKey for encryption/decryption
 * @property hint - Identifier for Nostr event filtering: SHA-256(PIN) truncated to 8 hex chars
 */
export interface PinKeyMaterial {
  key: CryptoKey
  hint: string
}
