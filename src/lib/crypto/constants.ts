import { BIP39_ENGLISH_WORDLIST } from './bip39-wordlist'

// PIN generation
export const PIN_LENGTH = 12
export const PIN_CHECKSUM_LENGTH = 1 // Last character is checksum
// Charset excludes ambiguous chars (0, 1, I, O, i, l, o) and uses iOS "123" keyboard symbols
// Symbols from iOS 123 layout: - / : ; ( ) $ & @ ? ! . , "
export const PIN_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789-/:;()$&@?!.,"'

// BIP-39 English wordlist (2048 words)
// Used for compact 7-word representation of the PIN
export const PIN_WORDLIST = BIP39_ENGLISH_WORDLIST

// First character charset split (for signaling method detection)
// Uppercase = Nostr, '2' = QR/Manual, Rest = Reserved for future
// I, L, O are excluded (ambiguous chars) to keep symmetry at 23 symbols and leave room for a future protocol
export const NOSTR_FIRST_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ' // 23 uppercase (excluding I, L, O)

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

// PIN hint length.
// 16 hex chars = 64 bits. The hint is both the Nostr `#h` filter tag and the
// displayed PIN fingerprint. 64 bits is birthday-collision-free at any realistic
// concurrent-transfer scale. The published wire hint gets the PBKDF2 work factor
// below; the local-only display fingerprint is a fast SHA-256 checksum.
export const PIN_HINT_LENGTH = 16 // hex characters

// Domain-separation salt for the PIN hint KDF.
// Shared (public) constant so sender and receiver derive the same hint from the
// same PIN, while defeating generic precomputed-hash (rainbow table) attacks.
// At runtime the current time bucket (see PIN_HINT_BUCKET_SEC) is appended so the
// hint rotates over time, the same way the QR signaling payload is XOR-obfuscated
// per time bucket.
export const PIN_HINT_SALT = 'secure-send:pin-hint:v1'

// Time-bucket width (seconds) mixed into the PIN hint salt. The hint a sender
// publishes is tied to the bucket it was created in, so the receiver must look
// back one bucket to cover the boundary case (sender published just before a
// bucket rollover). This is kept equal to TRANSFER_EXPIRATION_MS below: when the
// bucket width is >= the transfer lifetime, a non-expired event's bucket is always
// either the receiver's current bucket or the immediately previous one, so a
// single look-back is provably sufficient.
export const PIN_HINT_BUCKET_SEC = 3600 // 1 hour

// PBKDF2 iteration count for the PIN hint KDF. Slows down brute-force search
// over the PIN space (the only practical way to reverse a hint to its PIN).
// The hint is derived only once per completed PIN, so we match the main key's
// iteration count rather than using a cheaper one.
export const PIN_HINT_ITERATIONS = 600_000

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000 // 1 hour
export const PIN_DISPLAY_TIMEOUT_MS = 5 * 60 * 1000 // Duration (ms) the PIN is displayed before it expires (5 minutes)
