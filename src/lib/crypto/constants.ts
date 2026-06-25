import { BIP39_ENGLISH_WORDLIST } from './bip39-wordlist';

// PIN generation
export const PIN_LENGTH = 12;
export const PIN_CHECKSUM_LENGTH = 1; // Last character is checksum
// Charset excludes ambiguous chars (0, 1, I, O, i, l, o) and uses iOS "123" keyboard symbols
// Symbols from iOS 123 layout: - / : ; ( ) $ & @ ? ! . , "
export const PIN_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789-/:;()$&@?!.,"';

// BIP-39 English wordlist (2048 words)
// Used for compact 7-word representation of the PIN
export const PIN_WORDLIST = BIP39_ENGLISH_WORDLIST;

// Reserved first character marking a Nostr-signaling PIN.
// A single, case-sensitive letter (not a range): every generated PIN starts with
// this exact character and isValidPin requires it. Any other first character is
// left unassigned, reserved for a future signaling protocol.
export const NOSTR_FIRST_CHAR = 'N';

// PBKDF2 parameters (browser-compatible alternative to Argon2id)
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH = 'SHA-256';

// AES-GCM parameters
export const AES_KEY_LENGTH = 256; // bits
export const AES_NONCE_LENGTH = 12; // bytes (96 bits)
export const AES_TAG_LENGTH = 16; // bytes (128 bits)

// Salt length
export const SALT_LENGTH = 16;

// Chunk size for WebRTC data channel transfer
export const CHUNK_SIZE = 16 * 1024; // 16KB

// Encryption chunk size for P2P transfers
// 128KB chunks, each encrypted with unique nonce
// WebRTC data channel has ~256KB message limit, so 128KB + encryption overhead stays safe
export const ENCRYPTION_CHUNK_SIZE = 128 * 1024; // 128KB

// Max message size (100MB - transferred directly P2P over WebRTC)
export const MAX_MESSAGE_SIZE = 100 * 1024 * 1024; // 100MB

// PIN hint length.
// 16 hex chars = 64 bits. The hint is the Nostr `#h` filter tag. 64 bits is
// birthday-collision-free at any realistic concurrent-transfer scale. The hint is
// PBKDF2-stretched (see the iteration counts below).
export const PIN_HINT_LENGTH = 16; // hex characters

// PIN fingerprint length.
// 8 hex chars = 32 bits. The fingerprint is local-only and exists solely for two
// humans to visually compare on-device that they entered the same PIN. It is not a
// collision-resistance primitive and never crosses the network, so 32 bits is more
// than enough to make an accidental match between two distinct PINs negligible while
// keeping the displayed value short and easy to read aloud.
export const PIN_FINGERPRINT_LENGTH = 8; // hex characters

// Domain-separation salt for the PIN hint KDF.
// Shared (public) constant so sender and receiver derive the same hint from the
// same PIN, while defeating generic precomputed-hash (rainbow table) attacks.
// At runtime the current time bucket (see PIN_HINT_BUCKET_SEC) is appended so the
// hint rotates over time, the same way the QR signaling payload is XOR-obfuscated
// per time bucket.
export const PIN_HINT_SALT = 'secure-send:pin-hint:v1';

// Domain-separation salt for the local-only PIN fingerprint KDF. A distinct
// constant (not PIN_HINT_SALT) so the displayed fingerprint can never collide
// with the published wire hint, independent of iteration count or time bucket.
// No time bucket is appended at runtime — the fingerprint must stay constant so
// both sides always display the same value, even across an hour-bucket rollover.
export const PIN_FINGERPRINT_SALT = 'secure-send:pin-fingerprint:v1';

// Time-bucket width (seconds) mixed into the PIN hint salt. The hint a sender
// publishes is tied to the bucket it was created in, so the receiver must look
// back one bucket to cover the boundary case (sender published just before a
// bucket rollover). This is kept equal to TRANSFER_EXPIRATION_MS below: when the
// bucket width is >= the transfer lifetime, a non-expired event's bucket is always
// either the receiver's current bucket or the immediately previous one, so a
// single look-back is provably sufficient.
export const PIN_HINT_BUCKET_SEC = 3600; // 1 hour

// PBKDF2 iteration count for the PIN hint KDF. Slows down brute-force search
// over the PIN space (the only practical way to reverse a hint to its PIN).
// The hint is derived only once per completed PIN, so we match the main key's
// iteration count rather than using a cheaper one.
export const PIN_HINT_ITERATIONS = 600_000;

// PBKDF2 iteration count for the local-only PIN fingerprint KDF. The fingerprint
// is never published to relays — it exists solely for humans to visually compare
// on-device — so there is no relayed value for an attacker to brute-force back to
// the PIN. It is still PBKDF2-stretched (rather than a bare hash) for defence in
// depth against an attacker who observes the on-screen fingerprint, but uses a
// lighter work factor than PIN_HINT_ITERATIONS so PIN entry/display stays snappy.
export const PIN_FINGERPRINT_ITERATIONS = 200_000;

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour
export const PIN_DISPLAY_TIMEOUT_MS = 5 * 60 * 1000; // Duration (ms) the PIN is displayed before it expires (5 minutes)
