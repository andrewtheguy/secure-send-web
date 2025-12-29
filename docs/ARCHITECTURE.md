# Architecture

## Overview

Secure Send is a browser-based encrypted file and message transfer application. It supports PIN-based or passkey-based encryption for signaling and cloud transfers, two signaling methods (Nostr relays or QR codes), and enables direct P2P (WebRTC) data transfer with optional cloud fallback (Nostr mode only).

## Core Principles

1. **P2P First**: Direct WebRTC connections are always preferred for data transfer.
2. **Protocol-Agnostic Encryption**: All content is encrypted at the application layer using AES-256-GCM in 128KB chunks, regardless of transport encryption. This provides defense in depth and consistent security across all signaling methods.
3. **Memory-Efficient Streaming**: Content is encrypted/decrypted in streaming chunks. All receivers (P2P and cloud) preallocate buffers and write directly to calculated positions - no intermediate chunk arrays.
4. **Pluggable Signaling**: Signaling (Nostr, QR) is decoupled from the transfer layer. The same encryption/chunking logic is used regardless of signaling method.
5. **Dual PIN Representation**: A 12-character alphanumeric PIN serves as the shared secret. To improve shareability (e.g., via voice), this PIN can be bijectively mapped to a 7-word sequence from the BIP-39 wordlist.
6. **Passkey Support**: Alternative to PIN-based authentication using WebAuthn PRF extension. Keys are derived from hardware-backed secure elements (Touch ID, Face ID, Windows Hello) when passkeys are synced via password managers.

## Signaling Methods

By default, Nostr is used for signaling. QR/Manual exchange is available as an alternative under "Advanced Options" in the UI. Both sender and receiver must use the same method.

| Feature | Nostr (Default) | Manual Exchange (No Signaling Server) |
|---------|-----------------|---------------------------------------|
| Signaling Server | Decentralized relays | None (QR or copy/paste) |
| STUN Server | Yes (Google) | Yes (Google, when available) |
| Cloud Fallback | Yes (tmpfiles.org) | No |
| Reliability | Higher (fallback available) | P2P only |
| Privacy | Better (no central server) | Best (no signaling server) |
| Complexity | More complex | Manual exchange (QR or copy/paste) |
| Internet Required | Yes | No |
| Network Requirement | Any (via internet) | Same local network (without internet) |
| Recommended For | Unreliable networks, NAT issues | Offline transfers, local network only |

## Transfer Flow

### Nostr Mode - P2P Success Path (Preferred)
```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    Sender->>Receiver: PIN Exchange (via Nostr)
    Receiver-->>Sender: Ready ACK (seq=0)
    Sender->>Receiver: WebRTC Offer
    Receiver-->>Sender: WebRTC Answer
    Note over Sender,Receiver: P2P Data Channel (128KB encrypted chunks)
    Sender->>Receiver: DONE:N (total chunk count)
    Receiver-->>Sender: Complete ACK (seq=-1)
```

### Cloud Fallback Path (Nostr Mode - When P2P Connection Fails)
```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    Sender->>Receiver: PIN Exchange (via Nostr)
    Receiver-->>Sender: Ready ACK (seq=0)
    Note over Sender,Receiver: P2P connection timeout (30s)
    loop Each chunk
        Sender->>Receiver: ChunkNotify (chunk URL)
        Receiver->>Receiver: Download chunk
        Receiver-->>Sender: Chunk ACK (seq=chunk_index+1)
    end
    Receiver->>Receiver: Combine & decrypt
    Receiver-->>Sender: Complete ACK (seq=-1)
```

### Manual Exchange Mode (No Internet Required)
```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    Sender->>Sender: Generate PIN, create WebRTC offer
    Sender->>Sender: Encrypt signaling payload (includes salt)
    Sender->>Receiver: Display Offer QR (scan or paste)
    Receiver->>Receiver: Decrypt with PIN, derive key
    Receiver->>Receiver: Create WebRTC answer
    Receiver-->>Sender: Display Answer QR (scan or paste)
    Sender->>Receiver: Process answer, establish WebRTC
    Note over Sender,Receiver: P2P Data Channel (128KB encrypted chunks)
    Receiver-->>Sender: ACK
    Note over Sender,Receiver: If P2P connection fails, transfer fails (no server fallback)
```

**Requirements:**
- Both devices need either a working camera OR ability to copy/paste text (camera optional)
- Encrypted signaling data can be exchanged via QR scan or clipboard

**Network Requirements:**
- **With internet**: Works across different networks (STUN server enables NAT traversal)
- **Without internet**: Devices must be on same local network (WiFi, LAN, etc.)
- **Not air-gapped**: Requires some network connectivity between devices

**How it works:**
- With internet: STUN server (stun.l.google.com) enables connections across different networks via NAT traversal
- Without internet: WebRTC discovers local ICE candidates directly, connection establishes via local IP addresses

**QR Code Format:**
- QR: binary → binary QR code (8-bit byte mode, ~2000 bytes capacity)
- Copy/paste: base64 encode binary → text string for clipboard
## Key Components

### Cryptography (`src/lib/crypto/`)

| Component | Description |
|-----------|-------------|
| `pin.ts` | Alphanumeric (12-char) and Word (7-word) PIN handling, weighted checksums, signaling detection |
| `kdf.ts` | Key derivation using PBKDF2-SHA256 (600,000 iterations) |
| `passkey.ts` | WebAuthn PRF extension for passkey-based key derivation |
| `ecdh.ts` | ECDH key exchange (non-extractable keys), fingerprints, key confirmation, public key commitment, constant-time comparison |
| `aes-gcm.ts` | AES-256-GCM encryption/decryption |
| `stream-crypto.ts` | Streaming encryption/decryption (128KB chunks, protocol-agnostic) |
| `constants.ts` | Crypto parameters, charsets (69 chars), BIP-39 wordlist (2048 words) |

### PIN Architecture

Secure Send uses a sophisticated PIN system designed for both security and user-friendliness.

#### Alphanumeric Representation (Base-69)
- **Length**: 12 characters.
- **Charset**: 69 URL-safe characters (mixed case + digits + symbols).
- **Entropy**: ~67 bits (11 random chars + 1 checksum).
- **First Character**: Encodes the signaling method (`A-Z` for Nostr, `'2'` for Manual).
- **Last Character**: Weighted position-based checksum character.

#### Word-Based Representation (Base-2048)
- **mapping**: 7 words from the standard English BIP-39 wordlist.
- **Bijective**: Mapping between alphanumeric and word forms is lossless and 1:1, achieved using BigInt-based base conversion.
- **Validation**: Each word is individually validated against the 2048-word dictionary.

#### Typo Detection (Weighted Checksum)
To protect against manual entry errors, the PIN includes a custom checksum:
- **Algorithm**: `sum(char_index * (position + 1)) % charset_size`.
- **Detection**: Effectively catches single-character errors and swaps (transpositions).
- **Independent Validation**: Both characters and word sequences are validated against the same underlying checksum logic.

### Passkey Architecture

Passkeys provide an alternative to PIN-based authentication using the WebAuthn PRF extension for hardware-backed key derivation.

#### How It Works

1. **Credential Creation**: User creates a passkey at `/passkey`, stored in their password manager (1Password, iCloud Keychain, Google Password Manager)
2. **Passkey Sync**: Both sender and receiver must have the same passkey synced via their password manager
3. **PRF Extension**: WebAuthn PRF (Pseudo-Random Function) extension derives encryption keys from the passkey
4. **Hardware-Backed**: Keys are derived from device secure elements (Touch ID, Face ID, Windows Hello)

#### Passkey Fingerprint

- **Fingerprint**: Truncated SHA-256 hash of the passkey public ID (32 bytes derived via HKDF). We take the first 8 bytes (64 bits) of the hash and encode as 16 hex characters (formatted as `XXXX-XXXX-XXXX-XXXX` for display).
- **Purpose**: Used for Nostr event filtering and verification that sender/receiver have the same passkey

#### Passkey Public ID

- **Public ID**: 32 bytes derived from the passkey master key via HKDF (shareable, non-secret), encoded as base64 for copy/QR
- **Purpose**: Shared with contacts to target Nostr events and validate receiver commitments (`rpkc`)

#### Key Derivation Flow

```mermaid
flowchart TD
    Passkey[Passkey Authentication] --> PRF[WebAuthn PRF Extension]
    PRF --> MasterKey[Master Key HKDF]
    Salt[Random Salt] --> HKDF[HKDF-SHA256]
    MasterKey --> HKDF
    HKDF --> AESKey[AES-256-GCM Key]
```

1. **Master Key**: Single passkey prompt derives HKDF master key via PRF
2. **Per-Transfer Key**: HKDF with random salt derives unique AES key per transfer
3. **No PIN Required**: Biometric/device unlock replaces PIN entry

#### Mutual Trust Key Derivation (Non-Extractable Keys)

When using passkey mutual trust mode, the passkey master key is kept as a **non-extractable CryptoKey** and used directly for key confirmation and session binding:

```mermaid
flowchart TD
    MasterKey[Passkey Master Key<br/>non-extractable HKDF CryptoKey] --> AES[deriveKey → AES-256-GCM]
    MasterKey --> KC[deriveBits → Key Confirmation]
    MasterKey --> EphBind[deriveBits → Session Binding]
    Salt[Random Salt] --> AES
    Salt --> KC
    EphPub[Ephemeral Public Key] --> EphBind
```

**Security benefit**: No raw private key material is exposed to JavaScript. The passkey master key stays inside Web Crypto as a non-extractable `CryptoKey`, and all derived keys are produced via `deriveKey`/`deriveBits`. This prevents:
- XSS attacks from reading raw secret material via memory inspection
- Accidental logging or serialization of raw keys
- Side-channel exposure of raw private bytes

**Implementation**: `getPasskeyMasterKey()`, `derivePasskeyPublicId()`, `generateEphemeralSessionKeypair()`, and `deriveSessionEncryptionKey()` in `src/lib/crypto/passkey.ts`

#### Perfect Forward Secrecy (PFS)

Passkey mutual trust mode provides **Perfect Forward Secrecy** via ephemeral session keys, similar to TLS/HTTPS ECDHE. There are two flows depending on whether sender and receiver share the same passkey:

##### Self-Transfer Flow (Same Passkey - Optimized Single Round Trip)

When sender and receiver share the same passkey (e.g., synced via password manager), they derive the same PRF output and can encrypt/decrypt immediately:

```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    Note over Sender: Passkey auth → Master key + public ID
    Note over Sender: Generate ephemeral keypair
    Sender->>Receiver: Mutual Trust Event<br/>(encrypted metadata + epk + esb)
    Note over Receiver: Same passkey → Same master key
    Note over Receiver: Decrypt metadata immediately
    Note over Receiver: Verify session binding (same master key)
    Note over Receiver: Generate ephemeral keypair
    Receiver-->>Sender: Ready ACK (epk + esb)
    Note over Sender: Verify session binding
    Note over Sender,Receiver: Both derive: ECDH(ownEphPriv, peerEphPub) = sessionKey
    Note over Sender,Receiver: File data uses sessionKey (PFS protected)
```

##### Cross-User Flow (Different Passkeys - Two Round Trips)

When sender and receiver have different passkeys, there's no shared secret initially. An extra handshake round trip establishes the session key before metadata can be sent:

```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    Note over Sender: Passkey auth → Master key A + public ID A
    Note over Sender: Generate ephemeral keypair
    Sender->>Receiver: Handshake Event<br/>(NO payload, epk + esb)
    Note over Receiver: Passkey auth → Master key B + public ID B
    Note over Receiver: Verify fingerprint match
    Note over Receiver: Generate ephemeral keypair
    Receiver-->>Sender: Ready ACK (epk + esb)
    Note over Sender,Receiver: Both derive: ECDH(ownEphPriv, peerEphPub) = sessionKey
    Sender->>Receiver: Payload Event<br/>(encrypted metadata with sessionKey)
    Note over Receiver: Decrypt metadata
    Note over Sender,Receiver: File data uses sessionKey (PFS protected)
```

**Why two flows?**

| Aspect | Self-Transfer | Cross-User |
|--------|---------------|------------|
| Shared secret exists? | Yes (same PRF output) | No (different passkeys) |
| Round trips | 1 | 2 |
| Metadata encryption | Passkey-derived key | Session key (from ECDH) |
| Session binding verification | Yes (same master key) | N/A (different master keys prevent verification) |

**How it works:**

1. **Identity Material**: Passkey PRF derives a non-extractable master key and a public ID (for fingerprint verification)
2. **Ephemeral Keys**: Each session generates fresh ECDH keypairs using `crypto.subtle.generateKey()` - raw private key material is **NEVER** exposed to JavaScript
3. **Session Binding**: `HKDF(masterKey, ephemeralPub)` proves ephemeral keys are authorized by the passkey identity
   - **Self-transfer**: Both parties can verify each other's binding (same master key)
   - **Cross-user**: Binding cannot be verified (different master keys), security relies on fingerprint verification, RPKC, and contact token WebAuthn signature
4. **Session Key**: `ECDH(ownEphemeralPriv, peerEphemeralPub)` derives the actual encryption key

**Security benefit**: Compromising the passkey public ID or a single session's memory does NOT help decrypt past or future sessions because:
- Ephemeral private keys are generated via Web Crypto and never exposed as raw bytes
- Each session uses unique ephemeral keys that are discarded after use
- Even memory inspection during one session only reveals that session's ephemeral keys

**PFS is mandatory**: In passkey mode, both sender and receiver MUST provide ephemeral keys. Events/ACKs without ephemeral keys are rejected.

**Time-bound validity / clock tolerance**:
- Ephemeral keys have **no separate lifetime** beyond the transfer TTL; there is no explicit timestamp on `epk`/`esb`.
- Validity is **bounded by the exchange event TTL** (`TRANSFER_EXPIRATION_MS`, currently 1 hour) using `created_at` timestamps.
- Implementations should **reject session bindings** if the associated exchange event is expired; **no additional clock-skew window** is currently defined beyond the existing TTL check.

**Implementation**: `generateEphemeralSessionKeypair()`, `verifySessionBinding()`, `deriveSessionEncryptionKey()`, `getPasskeySessionKeypair()` in `src/lib/crypto/passkey.ts`

#### Dual Mode (Sender)

When passkey mode is enabled, the sender generates BOTH:
- Normal PIN + PIN-derived key
- Passkey fingerprint + passkey-derived key

Two PIN exchange events are published to Nostr (one for each mode). Receiver chooses their preferred authentication method, and the ACK includes a hint indicating which key was used.

#### Mutual Trust Security Enhancements

When using passkey mode, additional cryptographic protections are applied:

| Enhancement | Event Tag | Purpose |
|-------------|-----------|---------|
| Key Confirmation | `kc` | HKDF-derived hash proves both parties derived same shared secret (MITM detection) |
| Receiver Public ID Commitment | `rpkc` | SHA-256 of receiver's public ID prevents relay substitution attacks |
| Replay Nonce | `n` | 16-byte random nonce (base64) echoed in ACK prevents replay attacks within TTL |
| Constant-Time Comparison | N/A | All security-critical string comparisons use timing-attack-resistant comparison |
| Input Validation | N/A | Nonce must decode to exactly 16 bytes; key confirmation input validated as 16-byte Uint8Array |

**Mutual Trust Event Tags (Self-Transfer):**
```
['h', receiverFingerprint]     // For event filtering
['spk', senderFingerprint]     // Sender verification
['kc', keyConfirmHash]         // Key confirmation (MITM detection)
['rpkc', receiverPkCommitment] // Receiver public ID commitment (relay MITM prevention)
['n', nonce]                   // Replay nonce (base64, 16 bytes)
['s', salt]                    // Per-transfer salt
['t', transferId]              // Transfer ID
['type', 'mutual_trust']       // Event type
['expiration', timestamp]      // TTL (NIP-40)
['epk', ephemeralPubKey]       // PFS: Ephemeral public key (base64, 65 bytes)
['esb', sessionBinding]        // PFS: Session binding proof (base64, 32 bytes)
```

**Mutual Trust Handshake Event Tags (Cross-User - Phase 1):**
```
['h', receiverFingerprint]     // For event filtering
['spk', senderFingerprint]     // Sender verification
['rpkc', receiverPkCommitment] // Receiver public ID commitment
['n', nonce]                   // Replay nonce (base64, 16 bytes)
['s', salt]                    // Per-transfer salt
['t', transferId]              // Transfer ID
['type', 'mutual_trust_handshake'] // Event type
['expiration', timestamp]      // TTL (NIP-40)
['epk', ephemeralPubKey]       // Ephemeral public key (base64, 65 bytes)
['esb', sessionBinding]        // Session binding proof (base64, 32 bytes)
```
Note: No `['kc', ...]` tag - key confirmation requires shared secret which doesn't exist for cross-user transfers.

**Mutual Trust Payload Event Tags (Cross-User - Phase 2):**
```
['p', receiverPubkey]          // Receiver's Nostr pubkey
['t', transferId]              // Transfer ID
['type', 'mutual_trust_payload'] // Event type
['expiration', timestamp]      // TTL (NIP-40)
```
Note: Encrypted payload in event content, encrypted with session key from ephemeral ECDH.

**Ready ACK Tags (PFS):**
```
['epk', ephemeralPubKey]       // PFS: Receiver's ephemeral public key
['esb', sessionBinding]        // PFS: Receiver's session binding proof
```

**Verification Flow:**
1. Sender computes key confirmation hash, receiver public ID commitment, and random nonce
2. Receiver verifies RPKC matches own public ID (prevents relay MITM)
3. Receiver verifies key confirmation hash matches (detects shared secret mismatch)
4. Receiver echoes nonce in ready ACK
5. Sender verifies nonce match using constant-time comparison (prevents replay)

**Constant-Time Comparison Implementation:**

The `constantTimeEqual()` function in `src/lib/crypto/ecdh.ts` provides timing-attack-resistant string comparison:

- **Single loop**: Always iterates `maxLen = Math.max(a.length, b.length)` times
- **No early returns**: Length mismatch is detected via XOR (`a.length ^ b.length`) accumulated into result
- **Bounds checking**: Uses `i < a.length ? a.charCodeAt(i) : 0` instead of modulo indexing
- **Bitwise accumulation**: All differences accumulated with `result |= charA ^ charB`

> **Note:** This is a best-effort constant-time mitigation in JavaScript. True constant-time guarantees are not possible in JS due to JIT optimization, garbage collection, and string implementation details. However, this approach avoids obvious timing leaks from early returns or variable iteration counts.

**Input Validation:**

Security-critical functions validate inputs before cryptographic operations:

- `hashKeyConfirmation()`: Validates input is exactly 16-byte Uint8Array before SHA-256 digest
- `parseMutualTrustEvent()`: Validates nonce decodes to exactly 16 bytes, salt decodes to at least 16 bytes

#### Security Properties

| Property | PIN Mode | Passkey Self-Transfer | Passkey Cross-User |
|----------|----------|----------------------|-------------------|
| Key Source | User-memorized PIN | Hardware secure element | Hardware secure element |
| Brute Force Resistance | 600K PBKDF2 iterations | Hardware rate limiting | Hardware rate limiting |
| Phishing Resistance | None | Origin-bound credentials | Origin-bound credentials |
| Sync Method | Out-of-band sharing | Password manager sync | Contact token exchange |
| Verification | PIN match | Fingerprint comparison | Fingerprint + contact token |
| Key Confirmation | N/A | HKDF-derived hash | N/A (no shared secret) |
| Relay MITM Protection | N/A | Public ID commitment | Public ID commitment |
| Replay Protection | TTL only | TTL + nonce | TTL + nonce |
| Session Binding Verification | N/A | Yes (same master key) | No (different master keys) |
| Shared Secret Protection | Raw bytes in memory | Non-extractable CryptoKey | Non-extractable CryptoKey |
| Perfect Forward Secrecy | No | Yes (ephemeral ECDH) | Yes (ephemeral ECDH) |
| Round Trips | 1 | 1 | 2 (handshake + payload) |

### User Interface Architecture

#### `PinInput` (Receiver Side)
The input component is designed for high-performance manual entry:
- **Independent State**: Alphanumeric and Word modes maintain separate internal buffers (`charPinRef` and `wordPinRef`). Toggling does not convert contents; it switches context.
- **7-Box Word Grid**: Word entry uses individual inputs for each of the 7 slots.
- **Smart Focus**: Automatically advances to the next box upon entry of a valid word, space, or enter key.
- **Real-time Autocomplete**: 
  - Consults the BIP-39 wordlist starting from the first character.
  - Supports keyboard navigation (Arrows) and quick selection (Tab/Enter).
- **Robust Pasting**: 
  - Handles multi-word strings (comma/space/newline separated).
  - Validates all words in the pasted sequence before populating the grid.

#### `PinDisplay` (Sender Side)
The display component focuses on secure and clear communication:
- **Masking**: Automatically masks the PIN after the first copy operation to prevent shoulder surfing.
- **Contextual Copy**: The "Copy" button copies whichever format is currently visible (characters or words).
- **Ephemeral Visibility**: Includes a countdown progress bar showing remaining TTL until the local display expires.

**Key Parameters:**
- `MAX_MESSAGE_SIZE`: 100MB (maximum file size)
- `CLOUD_CHUNK_SIZE`: 10MB (chunk size for cloud uploads)
- `ENCRYPTION_CHUNK_SIZE`: 128KB (application-level encryption chunk size for all methods)
- `PBKDF2_ITERATIONS`: 600,000

### Nostr Signaling (`src/lib/nostr/`)

Uses Nostr protocol for decentralized signaling between sender and receiver.

**Event Kinds:**
| Kind | Purpose |
|------|---------|
| 24243 | PIN Exchange - Contains encrypted transfer metadata |
| 24242 | Data Transfer - ACKs, WebRTC signals, chunk notifications |

**Event Types (via tags):**
- `pin_exchange`: Initial transfer setup
- `ack`: Acknowledgments (seq=0 ready, seq=N chunk, seq=-1 complete)
- `signal`: WebRTC signaling (offer/answer/candidates)
- `chunk_notify`: Cloud chunk URL notification

**Files:**
- `types.ts`: Type definitions for payloads and events
- `events.ts`: Event creation and parsing functions
- `client.ts`: Nostr relay connection management
- `relays.ts`: Default relay configuration
- `discovery.ts`: Backup relay discovery

### Manual Exchange Signaling (`src/lib/manual-signaling.ts`)

Signaling method using QR codes or copy/paste for WebRTC offer/answer exchange. Camera is optional; signaling data can be exchanged via clipboard. **Network requirements:** With internet, works across different networks via STUN. Without internet, devices must be on same local network (not air-gapped - requires network connectivity).

**How it works:**
- Sender generates WebRTC offer with ICE candidates
- Both offer and answer include a required `createdAt` timestamp; receivers refuse to proceed if the offer is expired or missing TTL
- Payload is obfuscated using a time-bucketed seed to avoid casual inspection.

> [!IMPORTANT]
> **Real protection**: Manual signaling confidentiality comes from the 1-hour TTL plus ECDH key exchange and AES-256-GCM on the data channel. Obfuscation is only a secondary deterrent against casual inspection; expired payloads are useless even if seen.

**Binary Payload Format (SS02):**

The payload consists of two distinct layers to balance rapid identification with obfuscation of the content.

| Component | Length | Status | Description |
|-----------|--------|--------|-------------|
| **Outer Magic** | 4 bytes | Plaintext | Fixed header: `"SS02"` (`0x53 0x53 0x30 0x32`) |
| **Inner Buffer** | Variable | **Obfuscated** | Time-bucketed XOR-obfuscated content (detailed below) |

**Obfuscated Inner Buffer Structure:**

The following structure is revealed *after* successful de-obfuscation using the correct hourly seed:

| Component | Length | Status | Description |
|-----------|--------|--------|-------------|
| **Inner Magic** | 4 bytes | Obfuscated | Fixed marker: `"mag!"` (`0x6d 0x61 0x67 0x21`) |
| **Payload** | Variable | Obfuscated | Deflate-compressed `SignalingPayload` JSON |

**Verification Process:**
1. **Identification**: The receiver checks the first 4 bytes for the plaintext `"SS02"` header.
2. **Seed Testing**: The receiver iterates through candidate seeds for the current and previous hour (2-hour sliding window). 
3. **Optimized Check**: For each candidate seed, only the first 4 bytes of the inner buffer are de-obfuscated. If they match the `"mag!"` marker, the correct seed has been found.
4. **Full Processing**: The rest of the buffer is de-obfuscated, decompressed via deflate, and parsed as JSON.

**Time-Bucketed Obfuscation:**

The obfuscation seed changes every hour to ensure the **ephemerality** of signaling data and to make the payload **look more random**. This provides several benefits:
- **Casual Protection**: Offers a layer of deterrence against casual non-technical observers by making the raw data unreadable without the correct hourly seed.
- **Stale Data Prevention**: Prevents the utility of stale signaling data, such as a photograph of a QR code, a screenshot, or lingering clipboard contents.
- **Payload Randomness**: Ensures that signaling data generated at different times results in significantly different binary outputs.

Primary confidentiality is provided by the 1-hour TTL and ECDH + AES-256-GCM (see note above); obfuscation is additive, not the core control.

- **Bucket Size**: 1 hour (`3600` seconds).
- **Input (`bucketEpoch`)**: `floor(unix_timestamp_seconds / 3600)`.
- **Base Seed**: `0x9e3779b9`.
- **Algorithm**: A 32-bit MurmurHash3-style finalizer/mixer.

**Seed Derivation Steps:**
To ensure cross-implementation compatibility, the seed MUST be derived using the following steps (using 32-bit signed integer multiplication and unsigned right shifts):

1.  Initialize: `h = 0x9e3779b9 ^ bucketEpoch`
2.  Mix 1: `h = (h ^ (h >>> 16)) * 0x85ebca6b`
3.  Mix 2: `h = (h ^ (h >>> 13)) * 0xc2b2ae35`
4.  Finalize: `seed = (h ^ (h >>> 16)) >>> 0`

*Note: In environments like JavaScript, `Math.imul` should be used for the multiplication steps to ensure consistent 32-bit integer behavior.*

**Verification Window & Edge Cases:**
A 2-hour sliding window (current bucket + 1 previous bucket) is used to verify incoming payloads. This design has several implications:

-   **Validity Duration**: A payload's effective validity is between **1 and 2 hours**, aligning with the 1-hour backend TTL. If generated at the start of a bucket, it remains valid for 2 hours. If generated at the end, it remains valid for just over 1 hour.
-   **Clock Drift Tolerance**: The window provides inherent tolerance for clock drift (+/- 1 hour).
-   **Boundary Transitions**: When the hour rolls over, the previous bucket is dropped, and the new hour becomes the current bucket.
-   **Out-of-Sync Clocks**: If the sender and receiver clocks differ by more than the window's tolerance (e.g., >1 hour fast or slow), de-obfuscation will fail.

> [!NOTE]
| The obfuscation's goal is simply to avoid casual inspection. The actual security of the transfer is provided by ECDH mutual exchange and AES-256-GCM encryption of the data channel.

**Encoding Pipeline:**
1. `SignalingPayload` object → JSON string.
2. Compress with deflate (variable length).
3. Prepend fixed-length `"mag!"` marker (4 bytes).
4. XOR-obfuscate this inner buffer with the current hourly seed.
5. Prepend fixed-length plaintext `"SS02"` header (4 bytes).
6. Result: Final binary payload.




**Output Methods:**
| Method | Encoding | Use Case |
|--------|----------|----------|
| QR Code | Deflate-compressed binary | Camera available, most compact |
| Copy/Paste | Base64-encoded binary | No camera, text-safe for clipboard |

**Key Features:**
- No signaling server required - manual exchange via QR scan or copy/paste
- Camera optional - encrypted payload can be copied as text and pasted on other device
- No internet required when devices are on same local network
- With internet: works across different networks via STUN (stun.l.google.com) for NAT traversal
- Not air-gapped: requires network connectivity between devices (either local network or internet)
- Binary mode QR codes for efficient byte encoding
- Single QR code per payload (no chunking needed)
- Uses `zxing-wasm` for both generation and scanning

**Security Model:**
- **All modes**: PIN encrypts signaling metadata to prevent unauthorized connection establishment
- **QR mode**: Physical QR exchange adds a presence check, but PIN is still required to decrypt signaling
- **All modes**: Once WebRTC connection is established, DTLS encrypts all data in transit

### WebRTC (`src/lib/webrtc.ts`)

Handles direct peer-to-peer connections using WebRTC data channels.

**Features:**
- ICE candidate queuing for reliable connection establishment
- STUN server for NAT traversal (`stun.l.google.com:19302`)
- 128KB encrypted chunk messages with backpressure (WebRTC handles fragmentation)
- Backpressure support (waits for buffer to drain before sending more data)
- Connection state monitoring

### Cloud Storage (`src/lib/cloud-storage.ts`)

Fallback storage when P2P connection cannot be established (30s timeout window). Not used if P2P connects successfully.

**Features:**
- Multiple upload servers with automatic failover
- Multiple CORS proxies for download redundancy
- Service health caching
- Chunked upload/download for files >10MB

**Current Services:**
- Upload: tmpfiles.org, litterbox, uguu.se, x0.at
- CORS Proxies: corsproxy.io, leverson83, codetabs, cors-anywhere, allorigins

### React Hooks (`src/hooks/`)

**`use-nostr-send.ts`** - Sender logic (Nostr):
1. Read content (encrypt only if cloud fallback is needed)
2. Publish PIN exchange (without cloud URL)
3. Wait for receiver ready ACK
4. Attempt P2P connection (30s timeout for connection only)
5. If P2P connects: transfer via data channel (all-or-nothing, no cloud fallback)
6. If P2P connection fails: chunked cloud upload with ACK coordination
7. Wait for completion ACK

**`use-nostr-receive.ts`** - Receiver logic (Nostr):
1. Validate PIN and find exchange event
2. Send ready ACK
3. Listen for P2P signals OR chunk notifications
4. If P2P: receive via data channel
5. If cloud: download chunks, send ACKs, combine and decrypt
6. Send completion ACK

**Manual Exchange Mode:**

**`use-manual-send.ts`** - Sender logic (Manual Exchange):
1. Read content (file or text), validate size
2. Generate PIN and salt, derive encryption key
3. Create WebRTC offer with ICE candidates
4. Wait for ICE gathering to complete
5. Encrypt offer payload (includes salt) with PIN: JSON → deflate → encrypt → binary QR code
6. Display QR code and encrypted JSON copy button
7. Wait for user to input receiver's answer (scan or paste)
8. Process answer, establish WebRTC connection
9. Encrypt and send data in 128KB chunks via data channel
10. Wait for receiver ACK

**`use-manual-receive.ts`** - Receiver logic (Manual Exchange):
1. Validate PIN entered by user
2. Wait for user to input sender's offer (scan or paste)
3. Decrypt offer with PIN, extract metadata and salt
4. Derive decryption key from PIN and salt
5. Create WebRTC answer with ICE candidates
6. Encrypt answer payload with PIN: JSON → deflate → encrypt → binary QR code
7. Display QR code and encrypted JSON copy button
8. Wait for WebRTC connection to establish
9. Receive encrypted chunks, store temporarily
10. After transfer complete, decrypt all chunks and write to preallocated buffer
11. Present content

## Data Encryption

### Unified Transfer Layer

Both signaling methods (Nostr, Manual Exchange) share the same encryption middleware. This protocol-agnostic layer provides consistent security regardless of the transport mechanism.

**Why encrypt when WebRTC provides DTLS?**
- **Defense in depth**: Multiple encryption layers protect against implementation bugs
- **Consistent model**: Same encryption for P2P and cloud fallback
- **Key control**: Encryption key derived from user's PIN, not WebRTC keys
- **Verification**: Application-level encryption ensures end-to-end security

### PIN Exchange Payload
```typescript
interface PinExchangePayload {
  contentType: 'text' | 'file'
  transferId: string
  senderPubkey: string
  totalChunks: number
  relays?: string[]
  // File metadata (if file)
  fileName?: string
  fileSize?: number
  mimeType?: string
}
```

### Encryption Flow

**PIN Mode:**
1. **PIN Generation**: 12-character from mixed charset (excluding ambiguous chars)
2. **Salt Generation**: 16 random bytes (included in signaling payload for receiver)
3. **Key Derivation**: PBKDF2-SHA256 with 600,000 iterations
4. **Chunk Encryption**: AES-256-GCM with 12-byte nonce per 128KB chunk

**Passkey Mode:**
1. **Passkey Authentication**: WebAuthn prompt (biometric/device unlock)
2. **Master Key**: PRF extension output imported as HKDF key
3. **Salt Generation**: 16 random bytes (included in signaling payload)
4. **Key Derivation**: HKDF-SHA256 with salt derives per-transfer AES key
5. **Chunk Encryption**: Same AES-256-GCM with 12-byte nonce per 128KB chunk

### What's Encrypted Where

| Data | All P2P Methods | Cloud Transfer |
|------|-----------------|----------------|
| Signaling Payload | Encrypted (AES-GCM) | N/A |
| WebRTC Signals | Encrypted (AES-GCM) | N/A |
| File/Text Content | Encrypted (AES-GCM, 128KB chunks) | Encrypted (AES-GCM, whole file) |

### Streaming Encryption (All Methods)

All P2P transfers (Nostr, Manual Exchange) encrypt content in 128KB chunks using identical logic:

**Sender side:**
```typescript
for (let i = 0; i < contentBytes.length; i += ENCRYPTION_CHUNK_SIZE) {
  const plainChunk = contentBytes.slice(i, end)
  const encryptedChunk = await encryptChunk(key, plainChunk, chunkIndex)
  await connection.send(encryptedChunk)
  chunkIndex++
}
```

**Receiver side (memory-efficient assembly):**
```typescript
// Preallocate single buffer based on expected size
let contentData = new Uint8Array(totalBytes)

// On each chunk received:
const { chunkIndex, encryptedData } = parseChunkMessage(encryptedChunk)
const decryptedChunk = await decryptChunk(key, encryptedData)
const writePosition = chunkIndex * ENCRYPTION_CHUNK_SIZE
contentData.set(decryptedChunk, writePosition)  // Direct write, no intermediate storage
```

**Encrypted Chunk Format:**
```
[4 bytes: chunk index (big-endian)][12 bytes: nonce][ciphertext][16 bytes: auth tag]
```

**Benefits:**
- **Defense in depth**: AES-GCM on top of WebRTC DTLS
- **Streaming decryption**: Each chunk decrypted as it arrives
- **Memory efficiency**: Preallocated buffer with direct position writes - no intermediate chunk arrays
- **Out-of-order handling**: Chunks can arrive in any order and be placed correctly

```mermaid
flowchart TD
    PIN[PIN shared out-of-band] --> Signaling[Signaling offer/answer/ICE]
    Signaling -->|AES-GCM| EncryptedPayload[Encrypted payload<br/>includes salt]
    EncryptedPayload --> Decrypt[Decrypt to connect]
    Decrypt --> DTLS[WebRTC handshake<br/>DTLS]
    DTLS --> Channel[P2P data channel]
    Channel --> Chunks[128KB encrypted chunks]
    Chunks --> Write[Decrypt + direct buffer write at idx * 128KB]
```

### Cloud Transfer Memory Efficiency (Nostr Fallback)

Cloud transfers use the same memory-efficient receiving pattern:

```typescript
// Preallocate buffer based on expected total size
const estimatedSize = totalChunks * CLOUD_CHUNK_SIZE
let cloudBuffer = new Uint8Array(estimatedSize)

// On each cloud chunk downloaded:
const writePosition = chunkIndex * CLOUD_CHUNK_SIZE
cloudBuffer.set(chunkData, writePosition)  // Direct write, no intermediate storage
```

This ensures consistent memory behavior across all transfer modes - P2P and cloud fallback both avoid creating intermediate chunk arrays.

## Size Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max file size | 100MB | Memory constraints, cloud service limits |
| Encryption chunk size | 128KB | Balance of encryption overhead and streaming efficiency |
| Cloud chunk size | 10MB | Per-upload limit, memory efficiency |
| PIN length | 12 chars | Balance of usability and security |

## Timeout Configuration

| Timeout | Duration | Purpose |
|---------|----------|---------|
| P2P connection | 30 seconds | Time to establish WebRTC connection (offer/answer/ICE/channel open) |
| P2P offer retry | 5 seconds | Interval to retry WebRTC offer if no answer received |
| P2P data transfer | Unlimited | Once connected, data transfer has no timeout |
| Chunk ACK | 60 seconds | Time to download and acknowledge a cloud chunk |
| Overall transfer | 10 minutes | Maximum time for entire transfer (receiver side) |
| Transfer TTL | 1 hour | Transfer session validity (`TRANSFER_EXPIRATION_MS`) |
| Receiver PIN inactivity | 5 minutes | Clears PIN input if no changes made |

## TTL / Expiration Spec

Secure Send enforces a hard session TTL. Expired requests MUST NOT establish a session or begin transfer, even if the PIN/key is correct.

**Duration**
- `TRANSFER_EXPIRATION_MS` (currently 1 hour)

**TTL Anchor (start time)**
- **Nostr**: PIN exchange event `created_at` (seconds since epoch)
- **Manual Exchange**: `SignalingPayload.createdAt` (milliseconds since epoch)

**Enforcement Points (hard fail)**
- **Receiver-side (pre-session)**:
  - Reject expired/missing TTL before acknowledging or establishing a session (no `ready` ACK in Nostr; no WebRTC answer in Manual).
- **Sender-side (pre-transfer)**:
  - Re-check TTL immediately before sending any data (including at WebRTC DataChannel open and before any cloud upload fallback).

**No Backward Compatibility**
- Requests/payloads missing TTL fields are rejected (treated as invalid).
- Nostr P2P completion requires `DONE:N` (legacy `DONE` without chunk count is unsupported).

## Security Considerations

1. **Ephemeral Keys**: New keypair generated for each transfer
2. **Forward Secrecy**: PIN/passkey-derived key is unique per transfer (includes random salt) - applies to all modes
3. **No Server Trust**: Cloud storage and relays see only encrypted payloads and minimal routing metadata; plaintext never leaves the device
4. **PIN Entropy**: ~67 bits (11 random chars from 69-char set + 1 checksum)
5. **Brute-Force Resistance**: 600K PBKDF2 iterations for PIN mode; hardware rate limiting for passkey mode
6. **PIN/Passkey Role**: Encrypts signaling (preventing unauthorized P2P connection) AND content (defense in depth)
7. **Transport Security**: All P2P transfers (Nostr, Manual Exchange) use both AES-256-GCM encryption (128KB chunks) and WebRTC DTLS
8. **Protocol-Agnostic Security**: Same encryption layer used regardless of signaling method - no security difference between Nostr or Manual Exchange
9. **Passkey Security**: WebAuthn PRF extension provides hardware-backed key derivation with origin-bound credentials and phishing resistance
10. **Passkey Sync**: Requires same passkey synced via password manager (1Password, iCloud Keychain, Google Password Manager) - no out-of-band PIN sharing needed
11. **XSS Protection**: Sensitive cryptographic material (shared secrets, key derivation functions) stored in closure scope, not on global `window` object
12. **Resource Cleanup**: All error paths properly clean up timeouts and subscriptions to prevent resource leaks
13. **Input Validation**: Cryptographic functions validate inputs (nonce length, key confirmation size) before operations to provide deterministic errors
14. **Non-Extractable Keys**: In passkey mutual trust mode, the passkey master key and the ephemeral ECDH shared secret are kept as non-extractable `CryptoKey` objects - raw bytes never exposed to JavaScript, preventing exfiltration via XSS or memory inspection
15. **Perfect Forward Secrecy (PFS)**: Passkey mode uses ephemeral session keys generated via Web Crypto's `generateKey()` - raw private key material is NEVER exposed to JavaScript. Compromising the passkey public ID or a single session's memory does not help decrypt past or future sessions. PFS is mandatory in passkey mode.

## File Structure

```
src/
├── lib/
│   ├── crypto/              # Cryptographic functions
│   │   ├── constants.ts     # Parameters and limits
│   │   ├── pin.ts           # PIN generation/validation
│   │   ├── kdf.ts           # Key derivation (PBKDF2)
│   │   ├── passkey.ts       # Passkey/WebAuthn PRF key derivation
│   │   ├── aes-gcm.ts       # Encryption/decryption
│   │   └── stream-crypto.ts # Streaming chunk encryption (P2P)
│   ├── nostr/               # Nostr protocol (signaling option 1)
│   │   ├── types.ts         # Type definitions
│   │   ├── events.ts        # Event creation/parsing
│   │   ├── client.ts        # Relay client
│   │   └── relays.ts        # Default relays
│   ├── manual-signaling.ts  # Manual exchange signaling (signaling option 2)
│   ├── qr-utils.ts          # Binary QR code generation (zxing-wasm)
│   ├── webrtc.ts            # WebRTC connection management
│   ├── cloud-storage.ts     # Cloud fallback (Nostr mode only)
│   └── file-utils.ts        # File reading utilities
├── workers/
│   ├── qrGenerator.worker.ts    # Binary QR generation (zxing-wasm/full)
│   └── zxing-qr-scanner.worker.ts # QR scanning (zxing-wasm/reader)
├── hooks/
│   ├── use-nostr-send.ts    # Sender hook (Nostr mode)
│   ├── use-nostr-receive.ts # Receiver hook (Nostr mode)
│   ├── use-manual-send.ts   # Sender hook (Manual Exchange mode)
│   ├── use-manual-receive.ts # Receiver hook (Manual Exchange mode)
│   └── useQRScanner.ts      # Camera-based QR scanning hook
├── components/
│   └── secure-send/
│       ├── qr-display.tsx   # Binary QR code display
│       ├── qr-scanner.tsx   # QR scanner (binary mode)
│       └── qr-input.tsx     # Dual input (scan or paste)
└── pages/
    ├── send.tsx             # Send page
    ├── receive.tsx          # Receive page
    ├── about.tsx            # About page
    └── passkey.tsx          # Passkey setup/test page
```

**Crypto parameters**: Key tunables like `PBKDF2_ITERATIONS`, `ENCRYPTION_CHUNK_SIZE`, and `CLOUD_CHUNK_SIZE` live in [src/lib/crypto/constants.ts](src/lib/crypto/constants.ts) for quick lookup.
