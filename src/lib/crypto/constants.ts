// PIN generation
export const PIN_LENGTH = 8
export const PIN_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*+-=?'

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
export const MAX_MESSAGE_SIZE = 512 * 1024 // 512KB

// PIN hint length
export const PIN_HINT_LENGTH = 8 // hex characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000 // 1 hour
