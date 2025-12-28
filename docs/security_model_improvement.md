# Security Improvements for Passkey Mutual Trust Flow

## Overview

This document outlines security improvements for the passkey-based mutual trust flow in the secure file transfer system.

### Analyzed Files:
- `src/lib/crypto/passkey.ts` - WebAuthn PRF key derivation
- `src/lib/crypto/ecdh.ts` - ECDH key exchange and security utilities
- `src/hooks/use-nostr-send.ts` - Sender passkey flow
- `src/hooks/use-nostr-receive.ts` - Receiver passkey flow
- `src/lib/nostr/events.ts` - Mutual trust event creation

---

## Current Security Properties

### Implemented:
- Mutual authentication - Both parties prove passkey possession
- Forward secrecy - Ephemeral per-transfer keys via HKDF
- Phishing resistance - WebAuthn origin-bound credentials
- Hardware-backed - Keys derived from secure elements
- No shared secrets - No PIN to transmit out-of-band
- **Key Confirmation Exchange** - Cryptographic proof both parties derived same shared secret
- **Public Key Commitment** - Prevents relay MITM by binding sender to receiver's identity
- **Replay Protection** - Nonce-based freshness verification
- **Constant-time Comparisons** - Timing attack prevention for fingerprint verification

---

## Implemented Security Enhancements

### 1. Key Confirmation Exchange - IMPLEMENTED

**Status:** Implemented in Phase 1

**Implementation:**
- `deriveKeyConfirmation()` in `src/lib/crypto/ecdh.ts` - Derives 16-byte confirmation using HKDF with info="secure-send-key-confirm"
- `hashKeyConfirmation()` in `src/lib/crypto/ecdh.ts` - SHA-256 hash truncated to 32 hex chars
- `kc` tag added to mutual_trust events
- Receiver verifies key confirmation before accepting transfer

**Benefits:**
- Detects MITM attacks immediately
- Catches implementation bugs before data transfer
- Zero UX impact

---

### 2. Public Key Commitment Scheme - IMPLEMENTED

**Status:** Implemented in Phase 1

**Implementation:**
- `computePublicKeyCommitment()` in `src/lib/crypto/ecdh.ts` - SHA-256 of public key, first 16 bytes
- `verifyPublicKeyCommitment()` in `src/lib/crypto/ecdh.ts` - Constant-time verification
- `rpkc` tag added to mutual_trust events
- Receiver verifies commitment matches their own public key

**Benefits:**
- Prevents relay from substituting malicious receiver
- Binds sender's intent to specific receiver

---

### 3. Replay Protection with Nonces - IMPLEMENTED

**Status:** Implemented in Phase 1

**Implementation:**
- Sender generates 16-byte random nonce
- `n` tag added to mutual_trust events (base64 encoded)
- Receiver echoes nonce in ready ACK
- Sender verifies nonce match using `constantTimeEqual()`

**Benefits:**
- Prevents replay attacks within TTL window
- Ensures freshness of receiver's response

---

### 4. Constant-Time Fingerprint Comparison - IMPLEMENTED

**Status:** Implemented (from Phase 2)

**Implementation:**
- `constantTimeEqual()` in `src/lib/crypto/ecdh.ts`
- Used for all security-critical string comparisons:
  - Sender fingerprint verification
  - Key confirmation hash verification
  - Nonce verification

**Benefits:**
- Prevents timing side-channel attacks
- Security best practice for cryptographic comparisons

---

## Current Mutual Trust Event Structure

```
['h', receiverFingerprint]     // For event filtering
['spk', senderFingerprint]     // Sender verification
['kc', keyConfirmHash]         // Key confirmation (MITM detection)
['rpkc', receiverPkCommitment] // Receiver PK commitment (relay MITM prevention)
['n', nonce]                   // Replay nonce (base64, 16 bytes)
['s', salt]                    // Per-transfer salt
['t', transferId]              // Transfer ID
['type', 'mutual_trust']       // Event type
['expiration', timestamp]      // TTL (NIP-40)
```

---

## Remaining Improvements (Future Phases)

### Phase 2: Defense in Depth (Partially Complete)

- [ ] Key Separation for Signaling - Derive separate keys for signaling vs data
- [x] Fingerprint Verification Enhancement - Constant-time comparison (DONE)
- [ ] Passkey Credential Binding - Include credential ID in events

### Phase 3: Advanced Protections

- [ ] Secure Channel Binding - Bind DTLS fingerprint to signaling

---

## Key Files Modified

| File | Changes |
|------|---------|
| `src/lib/crypto/ecdh.ts` | Added `deriveKeyConfirmation`, `hashKeyConfirmation`, `computePublicKeyCommitment`, `verifyPublicKeyCommitment`, `constantTimeEqual` |
| `src/lib/nostr/events.ts` | Added kc, rpkc, n tags to createMutualTrustEvent and parsing |
| `src/hooks/use-nostr-send.ts` | Generate confirmations, verify ACK nonce |
| `src/hooks/use-nostr-receive.ts` | Verify RPKC, key confirmation, echo nonce |
