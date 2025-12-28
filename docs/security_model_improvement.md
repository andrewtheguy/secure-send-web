Security Improvements for Public Key Mutual Trust Model
Based on my analysis of your codebase, I can see you have a sophisticated secure file transfer system with two authentication modes:

Security Improvements for Passkey Mutual Trust Flow
Let me focus specifically on the passkey-based mutual trust flow in your codebase. I've analyzed the implementation in:

src/lib/crypto/passkey.ts - WebAuthn PRF key derivation
src/lib/crypto/ecdh.ts - ECDH key exchange
src/hooks/use-nostr-send.ts (lines 139-180) - Sender passkey flow
src/hooks/use-nostr-receive.ts (lines 104-150) - Receiver passkey flow
src/lib/nostr/events.ts - Mutual trust event creation
Current Passkey Flow Architecture
How It Works Now
Sender Side (use-nostr-send.ts):

User enables "Use Passkey" and provides receiver's public key
Authenticates with passkey → derives ECDH keypair via PRF
Computes shared secret: deriveSharedSecret(privateKey, receiverPublicKey)
Derives AES key: deriveAESKeyFromSecret(sharedSecret, salt)
Publishes mutual_trust event with sender fingerprint tag
Receiver Side (use-nostr-receive.ts):

Authenticates with passkey → derives ECDH keypair via PRF
Searches for events with their fingerprint as hint
Verifies sender fingerprint matches expected
Computes shared secret with sender's public key
Derives AES key and decrypts payload
Current Security Properties
✅ Mutual authentication - Both parties prove passkey possession
✅ Forward secrecy - Ephemeral per-transfer keys via HKDF
✅ Phishing resistance - WebAuthn origin-bound credentials
✅ Hardware-backed - Keys derived from secure elements
✅ No shared secrets - No PIN to transmit out-of-band

Technical Security Improvements (No UX Impact)
1. Explicit Key Confirmation Exchange ⭐ HIGH PRIORITY
Current Gap: No cryptographic proof that both parties derived the same shared secret.

Problem Scenario:

Implementation bug in ECDH derivation
Incompatible HKDF parameters
Public key corruption during transmission
Result: Silent failure or garbled data
Solution: Add key confirmation round-trip

typescript
// After deriving shared secret, compute confirmation value
const confirmValue = await crypto.subtle.deriveBits(
  {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: salt,
    info: new TextEncoder().encode('secure-send-key-confirm')
  },
  sharedSecretKey,
  128 // 16 bytes
)
// Sender includes H(confirmValue) in mutual_trust event
// Receiver computes their confirmValue and verifies hash matches
// If mismatch → abort before data transfer
Benefits:

Detects MITM attacks immediately (attacker can't forge confirmation)
Catches implementation bugs before data transfer
No extra round trips (piggyback on existing ready ACK)
Zero UX impact (happens during connection phase)
Implementation:

Add kc (key confirmation) tag to mutual_trust event
Receiver verifies before sending ready ACK
Sender verifies receiver's confirmation in ACK
2. Public Key Commitment Scheme
Current Gap: Receiver's public key is revealed in the ready ACK, but sender has no way to verify it wasn't substituted by a malicious relay.

Solution: Sender commits to expected receiver public key upfront

typescript
// Sender (when creating mutual_trust event):
const receiverPubkeyCommitment = await crypto.subtle.digest(
  'SHA-256',
  receiverPublicKey
)
// Include first 16 bytes as 'rpkc' tag
// Receiver (when sending ready ACK):
// Sender verifies: H(receiver_pubkey_from_ACK) === commitment
Benefits:

Prevents relay from substituting malicious receiver
Binds sender's intent to specific receiver
No extra messages (uses existing event tags)
Current Code Location:

Sender already has receiverPublicKey at line 166 in use-nostr-send.ts
Just need to add commitment tag to createMutualTrustEvent()
3. Authenticated Encryption for WebRTC Signaling
Current Implementation (use-nostr-send.ts lines 382-393):

typescript
const signalPayload = { type: 'signal', signal }
const signalJson = JSON.stringify(signalPayload)
const encryptedSignal = await encrypt(key, new TextEncoder().encode(signalJson))
Issue: Uses the same key for both signaling and data transfer.

Enhancement: Derive separate keys for different purposes

typescript
// Derive signaling key (different from data key)
const signalingKey = await crypto.subtle.deriveKey(
  {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: salt,
    info: new TextEncoder().encode('secure-send-signaling')
  },
  sharedSecretKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt']
)
// Use signalingKey for WebRTC offer/answer/ICE
// Use dataKey for actual file transfer
Benefits:

Key separation - Compromise of one doesn't affect the other
Domain separation - Different contexts use different keys
Defense in depth - Limits blast radius of key exposure
4. Replay Protection with Nonces
Current Implementation: TTL-based expiration (1 hour)

Gap: Within the TTL window, events could be replayed.

Solution: Add cryptographic nonce to mutual_trust events

typescript
// Sender generates random nonce
const nonce = crypto.getRandomValues(new Uint8Array(16))
// Include in mutual_trust event as 'n' tag
// Receiver must echo nonce in ready ACK
// Sender verifies nonce matches before proceeding
Benefits:

Prevents replay attacks within TTL window
Ensures freshness of receiver's response
Minimal overhead (16 bytes)
Implementation:

Add nonce to createMutualTrustEvent() in file:src/lib/nostr/events.ts
Store nonce in sender state
Verify in ready ACK handler
5. Fingerprint Verification Enhancement
Current Implementation (use-nostr-receive.ts lines 226-229):

typescript
if (parsed.senderFingerprint !== expectedSenderFingerprint) {
  console.log(`Sender fingerprint mismatch: ...`)
  continue
}
Enhancement: Make verification more robust

typescript
// Constant-time comparison to prevent timing attacks
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}
// Use in verification
if (!constantTimeEqual(parsed.senderFingerprint, expectedSenderFingerprint)) {
  // Reject silently (don't log details)
  continue
}
Benefits:

Prevents timing side-channel attacks
Avoids leaking information about expected fingerprint
Security best practice for cryptographic comparisons
6. Passkey Credential Binding
Current Gap: No binding between passkey credential and transfer session.

Enhancement: Include credential ID in mutual trust event

typescript
// During passkey authentication, get credential ID
const credential = assertion as PublicKeyCredential
const credentialId = base64urlEncode(new Uint8Array(credential.rawId))
// Include in mutual_trust event as 'cid' tag
// Receiver verifies their credential ID matches
Benefits:

Ensures both parties use the same synced passkey
Detects if wrong passkey was used
Helps debug sync issues
Note: Credential ID is not secret (it's used for authentication), so safe to include.

7. Secure Channel Binding for WebRTC
Current Gap: No binding between Nostr signaling channel and WebRTC data channel.

Solution: Include WebRTC fingerprint in signaling

typescript
// After WebRTC connection establishes, get DTLS fingerprint
const pc = rtc.getPeerConnection()
const localDesc = pc.localDescription
const dtlsFingerprint = extractDTLSFingerprint(localDesc.sdp)
// Verify peer's DTLS fingerprint matches what was in signaling
// Prevents MITM between signaling and data channels
Benefits:

Binds signaling channel to data channel
Prevents channel substitution attacks
Standard practice in secure WebRTC
Recommended Implementation Priority
Phase 1: Critical Security Enhancements (High Impact)
Key Confirmation Exchange - Detects MITM and implementation bugs
Public Key Commitment - Prevents relay substitution attacks
Replay Protection with Nonces - Ensures freshness
Phase 2: Defense in Depth
Key Separation for Signaling - Limits key compromise impact
Fingerprint Verification Enhancement - Prevents timing attacks
Passkey Credential Binding - Ensures correct passkey usage
Phase 3: Advanced Protections
Secure Channel Binding - Binds signaling to data channel
Why These Don't Add UX Burden
All improvements happen transparently during the existing handshake:

✅ No extra user prompts - All cryptographic operations are automatic
✅ No additional passkey authentications - Uses existing PRF output
✅ No extra waiting - Happens in parallel with connection establishment
✅ No new UI elements - All backend security enhancements
✅ Fail fast - Errors detected before data transfer (better UX)
The key insight: The passkey flow already requires waiting for connection establishment. These security checks happen during that existing wait time, adding negligible latency (a few milliseconds for hash computations).

Current Strengths to Preserve
Your passkey implementation is already excellent:

✅ WebAuthn PRF extension for deterministic key derivation
✅ ECDH mutual trust with P-256 curve
✅ HKDF for per-transfer key derivation
✅ Fingerprint-based event filtering
✅ Sender/receiver fingerprint verification
✅ Hardware-backed security (Touch ID, Face ID, etc.)
These improvements add cryptographic proofs and defense in depth without changing the user experience.