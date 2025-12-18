// PIN generation
export const PIN_LENGTH = 12
export const PIN_CHECKSUM_LENGTH = 1 // Last character is checksum
// Charset excludes ambiguous chars (0, 1, I, O, i, l, o) and uses iOS "123" keyboard symbols
// Symbols from iOS 123 layout: - / : ; ( ) $ & @ ? ! . , "
export const PIN_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789-/:;()$&@?!.,"'

// First character charset split (for signaling method detection)
// Uppercase = Nostr, Lowercase = PeerJS, '2' = QR, Rest = Reserved for future
export const NOSTR_FIRST_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ' // 23 uppercase (excluding I, L, O)
export const PEERJS_FIRST_CHARSET = 'abcdefghjkmnpqrstuvwxyz' // 23 lowercase (excluding i, l, o)
export const QR_FIRST_CHARSET = '2' // Single digit for QR method
// Reserved for future protocols: '3456789-/:;()$&@?!.,"' (remaining digits + symbols)

// PBKDF2 parameters (browser-compatible alternative to Argon2id)
export const PBKDF2_ITERATIONS = 600_000
export const PBKDF2_HASH = 'SHA-256'

// AES-GCM parameters
export const AES_KEY_LENGTH = 256 // bits
export const AES_NONCE_LENGTH = 12 // bytes (96 bits)
export const AES_TAG_LENGTH = 16 // bytes (128 bits)

// Salt length
export const SALT_LENGTH = 16

// Chunk size for WebRTC data channel transfer
export const CHUNK_SIZE = 16 * 1024 // 16KB

// Encryption chunk size for P2P transfers
// 128KB chunks, each encrypted with unique nonce
// WebRTC data channel has ~256KB message limit, so 128KB + encryption overhead stays safe
export const ENCRYPTION_CHUNK_SIZE = 128 * 1024 // 128KB

// Cloud chunk size for chunked uploads (when P2P fails)
export const CLOUD_CHUNK_SIZE = 10 * 1024 * 1024 // 10MB per cloud chunk

// Max message size (100MB - P2P handles full size, cloud falls back to chunked)
export const MAX_MESSAGE_SIZE = 100 * 1024 * 1024 // 100MB

// PIN hint length
export const PIN_HINT_LENGTH = 8 // hex characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000 // 1 hour
export const PIN_DISPLAY_TIMEOUT_MS = 5 * 60 * 1000 // Duration (ms) the PIN is displayed before it expires (5 minutes)
