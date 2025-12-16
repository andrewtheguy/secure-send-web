// PIN generation
export const PIN_LENGTH = 12
// Charset excludes ambiguous chars (0, 1, I, O, i, l, o) and uses iOS "123" keyboard symbols
// Symbols from iOS 123 layout: - / : ; ( ) $ & @ ? !
export const PIN_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789-/:;()$&@?!'

// PBKDF2 parameters (browser-compatible alternative to Argon2id)
export const PBKDF2_ITERATIONS = 600_000
export const PBKDF2_HASH = 'SHA-256'

// AES-GCM parameters
export const AES_KEY_LENGTH = 256 // bits
export const AES_NONCE_LENGTH = 12 // bytes (96 bits)
export const AES_TAG_LENGTH = 16 // bytes (128 bits)

// Salt length
export const SALT_LENGTH = 16

// Chunk size for data transfer
export const CHUNK_SIZE = 16 * 1024 // 16KB

// Max message size
// LIMITATION: This 10MB limit is chosen to balance user convenience with browser memory constraints and
// relay DoS protection.
// 1. Relays: We use 16KB chunks, so we don't hit single-payload limits (usually 64KB+).
//    However, sending 10MB total (640 chunks) requires rate limiting to avoid "flood" rejection.
// 2. Memory: The entire file is loaded into memory (Uint8Array). 10MB is safe for most modern devices,
//    but 100MB+ would risk crashing mobile browsers.
// 3. Validation: Both Sender and Receiver MUST enforce this limit to prevent allocation exhaustion attacks.
export const MAX_MESSAGE_SIZE = 10 * 1024 * 1024 // 10MB

// PIN hint length
export const PIN_HINT_LENGTH = 8 // hex characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000 // 1 hour
