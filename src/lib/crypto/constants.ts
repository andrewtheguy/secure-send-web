// PIN generation
export const PIN_LENGTH = 10;
export const PIN_CHECKSUM_LENGTH = 1; // Last character is checksum
export const PIN_GROUP_LENGTH = 5; // Displayed/entered as XXXXX-XXXXX

// Crockford base32 alphabet: digits + uppercase letters, excluding I, L, O
// (mapped from look-alikes on input: I/L -> 1, O -> 0) and U (excluded to avoid
// accidental words). Case-insensitive on entry.
export const PIN_CHARSET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// PIN rotation. The sender mints a fresh PIN and publishes a new rendezvous
// event every PIN_ROTATION_MS, and honors the PIN_ACTIVE_GENERATIONS most
// recent PINs when verifying a receiver's claim, so a PIN read just before a
// rotation still authenticates. PIN_TTL_MS is the resulting validity of any
// single PIN: it bounds rendezvous-event freshness on the receiver and is the
// NIP-40 expiration the sender attaches so relays can drop stale events.
export const PIN_ROTATION_MS = 60_000;
export const PIN_ACTIVE_GENERATIONS = 3;
export const PIN_TTL_MS = PIN_ROTATION_MS * PIN_ACTIVE_GENERATIONS;

// How many earlier rotation buckets the receiver derives hints for when
// locating the rendezvous event. A rendezvous event is accepted up to
// PIN_TTL_MS old; since hint buckets are PIN_ROTATION_MS wide and publication
// is not aligned to bucket boundaries, an event of age exactly PIN_TTL_MS can
// sit PIN_ACTIVE_GENERATIONS buckets back, so the look-back must equal
// PIN_ACTIVE_GENERATIONS to provably cover the whole non-expired window.
export const PIN_HINT_LOOKBACK_BUCKETS = PIN_ACTIVE_GENERATIONS;

// PBKDF2 parameters for the PIN root derivation (browser-native alternative to
// a memory-hard KDF). The PIN no longer derives any content-encryption keys —
// those come from an ephemeral ECDH exchange — so the KDF only has to make
// brute-forcing a captured rendezvous record slow relative to the ~PIN_TTL_MS
// window in which a recovered PIN is useful (before the first claim locks the
// transfer to one receiver).
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH = 'SHA-256';

// Domain-separation salt for the PBKDF2 PIN-root derivation. Public constant:
// it defeats generic precomputed-hash tables while letting both sides derive
// the same root from the same PIN.
export const PIN_ROOT_SALT = 'secure-send:pin-root:v2';

// HKDF salt shared by every derivation off the PIN root; each purpose is
// domain-separated by its HKDF info label ('hint:<bucket>', 'auth',
// 'rendezvous', 'fingerprint') so no two purposes ever share a key.
export const PIN_HKDF_SALT = 'secure-send:pin:v2';

// AES-GCM parameters
export const AES_KEY_LENGTH = 256; // bits
export const AES_NONCE_LENGTH = 12; // bytes (96 bits)
export const AES_TAG_LENGTH = 16; // bytes (128 bits)

// Salt length
export const SALT_LENGTH = 16;

// Encryption chunk size for P2P transfers
// 128KB chunks, each encrypted with unique nonce
// WebRTC data channel has ~256KB message limit, so 128KB + encryption overhead stays safe
export const ENCRYPTION_CHUNK_SIZE = 128 * 1024; // 128KB

// Max message size (100MB - transferred directly P2P over WebRTC)
export const MAX_MESSAGE_SIZE = 100 * 1024 * 1024; // 100MB

// PIN hint length.
// 16 hex chars = 64 bits. The hint is the Nostr `#h` filter tag. 64 bits is
// birthday-collision-free at any realistic concurrent-transfer scale. Deriving
// it requires the full PBKDF2 PIN-root stretch, so it cannot be reversed to a
// PIN faster than brute-forcing the PIN space.
export const PIN_HINT_LENGTH = 16; // hex characters

// PIN fingerprint length.
// 8 uppercase base32 chars (RFC 4648, the Tor v3 .onion alphabet) = 40 bits. The
// fingerprint is local-only and exists solely for two humans to visually compare
// on-device that they entered the same PIN. It is not a collision-resistance primitive
// and never crosses the network, so 40 bits is more than enough to make an accidental
// match between two distinct PINs negligible while keeping the displayed value short
// and easy to read aloud.
export const PIN_FINGERPRINT_LENGTH = 8; // uppercase base32 characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour (manual-exchange session TTL)
export const PIN_DISPLAY_TIMEOUT_MS = 5 * 60 * 1000; // Total time the sender keeps rotating/waiting before giving up (5 minutes)
