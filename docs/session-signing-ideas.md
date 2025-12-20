# Session Signing - Future Enhancement Ideas

This document outlines potential approaches for adding **session signing** to secure-send. Session signing allows sender and receiver to cryptographically verify each other's identity before transferring files.

## Current State (SS02)

```
Sender: ECDH keypair → QR(ECDH pubkey + SDP) → Receiver
Receiver: ECDH keypair → QR(ECDH pubkey + SDP) → Sender
Both: Derive shared secret via ECDH
```

- **Encryption**: Strong (ECDH + AES-256-GCM)
- **Identity**: None - you trust physical QR exchange

---

## Why Add Session Signing?

| Without Signing | With Signing |
|-----------------|--------------|
| You don't know WHO created the offer | Display verified identity (npub, device) |
| MITM could intercept and replace QR | Signature proves origin |
| Trust based on physical exchange only | Cryptographic identity verification |

---

## Approach Comparison

| Feature | WebAuthn | NIP-07 | NIP-46 | Ephemeral |
|---------|----------|--------|--------|-----------|
| Private key location | Authenticator | Browser extension | External app | Browser |
| Cross-device signing | No | No | Yes | No |
| Persistent identity | No | Yes (npub) | Yes (npub) | No |
| Mobile support | Yes* | No | Yes | Yes |
| Offline capable | Yes | Yes | No** | Yes |
| Setup required | Authenticator | Extension | Signer app | None |
| Identity format | Device-bound | Nostr npub | Nostr npub | None |

*Platform authenticator or security key
**Can work offline with local signer via NIP-55

---

# Option 1: WebAuthn Session Signing

## Concept

Use WebAuthn (FIDO2) to create ephemeral credentials that sign session data. Provides hardware-backed authentication without external dependencies.

## Flow

```
Sender: WebAuthn credential → Sign(ECDH pubkey + timestamp) → QR(sig + cred + ECDH + SDP)
Receiver: Verify sig → Create credential → Sign → QR(sig + cred + ECDH + SDP)
Sender: Verify receiver sig → Derive shared secret via ECDH
```

## Pros
- Hardware-backed (secure enclave, security key)
- Works offline
- No external dependencies
- Ephemeral credentials (no identity linkage)

## Cons
- Requires authenticator hardware
- Device-bound only (can't verify "who", just "same device")
- No persistent identity

## Implementation Notes
- Payload format: SS03
- Use `attestation: 'none'`, `residentKey: 'discouraged'`
- ES256 algorithm for P-256 compatibility
- All keys `extractable: false`

---

# Option 2: NIP-07 Extension Signing

## Concept

Use Nostr browser extensions (nos2x, Alby) to sign session data via `window.nostr` API. Like MetaMask for Nostr.

## Flow

```
Browser Extension (nos2x, Alby)
    ↓ holds private key
    ↓ exposes window.nostr API
Web App calls window.nostr.signEvent(event)
    ↓ extension prompts user
    ↓ returns signature + pubkey
```

## Pros
- Simple API, widely supported
- Private key never leaves extension
- Works with existing Nostr ecosystem
- Persistent identity (npub)
- Identity verification via npub display

## Cons
- Requires browser extension installation
- Desktop-only (no mobile)

## Implementation

```typescript
if (window.nostr) {
  const pubkey = await window.nostr.getPublicKey()
  const signedEvent = await window.nostr.signEvent({
    kind: 24244,
    content: JSON.stringify({ ecdhPubkey, timestamp, metadata }),
    created_at: Math.floor(Date.now() / 1000),
    tags: []
  })
}
```

---

# Option 3: NIP-46 Remote Signing

## Concept

Connect to external signer app (Amber, nsec.app) via Nostr relay. Like WalletConnect for Nostr.

## Flow

```
Mobile/Desktop Signer App (Amber, nsec.app)
    ↓ holds private key
    ↓ connects via Nostr relay
Web App ←→ Encrypted channel ←→ Signer
    ↓ sends signing request
    ↓ signer prompts user
    ↓ returns signature via relay
```

1. Web app displays QR with `nostrconnect://` or `bunker://` URI
2. User scans with signer app
3. Encrypted session via relay
4. Web app sends signing requests
5. Signer prompts, signs, returns signature

## Pros
- Cross-device (sign on phone for laptop session)
- Mobile-friendly
- Private key on secure device
- Same identity across devices (npub)

## Cons
- Requires relay connectivity
- More complex setup
- Depends on signer app ecosystem

## Implementation

```typescript
const connectURI = `nostrconnect://${signerPubkey}?relay=${relayUrl}&metadata=${encodeURIComponent(appMetadata)}`
// Display as QR, user scans with Amber/nsec.app
await nostrConnect.signEvent({ kind: 24244, content: sessionDataJSON })
```

---

# Option 4: NIP-55 Android Intent Signing

## Concept

Use Android intents to request signatures from signer apps like Amber.

## Flow

```
Android App (Amber)
    ↓ registered as signer intent handler
Web App → Android Intent → Signer App
    ↓ prompts user
    ↓ returns signature via intent result
```

## Pros
- Native Android UX
- No relay needed
- Fast, local signing

## Cons
- Android only
- Requires compatible signer app

---

# Enhancement A: Nostr-Signed QR Exchange

## Goal

Keep QR/manual exchange flow, add Nostr signature for identity verification.

## Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ SENDER                                                          │
├─────────────────────────────────────────────────────────────────┤
│ 1. Connect to Nostr signer (NIP-07 or NIP-46)                  │
│ 2. Generate ephemeral ECDH keypair                              │
│ 3. Sign session data: { ecdhPubkey, timestamp }                │
│ 4. Create QR: SS05(ECDH + Nostr sig + npub + SDP)              │
└─────────────────────────────────────────────────────────────────┘
                              ↓ Show QR / Paste
┌─────────────────────────────────────────────────────────────────┐
│ RECEIVER                                                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. Scan QR                                                      │
│ 2. Verify Nostr signature → Display "From: npub1abc..."        │
│ 3. User confirms: "Yes, that's the sender's npub"              │
│ 4. Connect own Nostr signer                                     │
│ 5. Sign own session data, create answer QR                      │
└─────────────────────────────────────────────────────────────────┘
```

## Benefits
- Identity verification via npub display
- Replay protection (signature binds to session)
- Trust building with repeat contacts
- Works over less-secure channels (screenshot, messaging)

---

# Enhancement B: Nostr Relay Push

## Goal

Push offer through Nostr relays to recipient's npub - no QR scanning needed.

## Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ SENDER                                                          │
├─────────────────────────────────────────────────────────────────┤
│ 1. Enter recipient's npub (or NIP-05 like user@domain)         │
│ 2. Connect to Nostr signer                                      │
│ 3. Generate ECDH keypair                                        │
│ 4. Create signed offer event (kind 24245)                       │
│ 5. Encrypt to recipient's npub (NIP-44)                        │
│ 6. Publish to relays, wait for answer                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ RECEIVER                                                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. Subscribe to events mentioning own npub                      │
│ 2. Receive encrypted offer, decrypt                             │
│ 3. Verify sender signature → Display "From: npub1xyz..."       │
│ 4. Approve, sign answer, publish                                │
│ 5. Establish WebRTC P2P connection                              │
└─────────────────────────────────────────────────────────────────┘
```

## Event Structure (kind 24245)

```json
{
  "kind": 24245,
  "pubkey": "<sender npub>",
  "created_at": 1234567890,
  "tags": [["p", "<recipient npub>"], ["expiration", "1234571490"]],
  "content": "<NIP-44 encrypted offer payload>",
  "sig": "<schnorr signature>"
}
```

## Benefits
- No QR scanning, works remotely
- Async (receiver doesn't need to be online initially)
- Address book / NIP-05 lookup
- Encrypted signaling via NIP-44

## Comparison: QR vs Relay Push

| Aspect | QR Exchange | Relay Push |
|--------|-------------|------------|
| Physical presence | Required | Not required |
| Works offline | Yes | No |
| Recipient discovery | Visual/physical | npub/NIP-05 |
| Async initiation | No | Yes |
| Privacy | Maximum | Metadata on relays |

---

# Unified Signer Interface

## Concept

Abstract multiple signing backends behind a common interface:

```typescript
interface SessionSigner {
  type: 'nip07' | 'nip46' | 'nip55' | 'webauthn' | 'ephemeral'
  getPublicKey(): Promise<string>
  signSessionData(data: SessionData): Promise<SignedSessionData>
  verifySignature(signedData: SignedSessionData): Promise<boolean>
}

async function detectSigners(): Promise<SessionSigner[]> {
  const signers: SessionSigner[] = []
  if (window.nostr) signers.push(new NIP07Signer())
  if (isWebAuthnAvailable()) signers.push(new WebAuthnSigner())
  signers.push(new EphemeralSigner()) // always available
  return signers
}
```

---

# Security Considerations

## Key Separation
- **ECDH keys**: Always ephemeral, browser-generated, forward secrecy
- **Signing keys**: Long-lived, external signer, authentication only
- Compromise of signing key doesn't reveal past session content

## Identity Verification
- Display `npub1...` or NIP-05 for user verification
- Out-of-band confirmation ("Is your npub xyz...?")
- Optional: web-of-trust / contact list

## Replay Prevention
- Timestamp in signed data
- Unique session ID / nonce
- Short validity window (5 minutes)

## Key Rotation & Revocation
For Nostr-based signing, key rotation means publishing a new npub and updating NIP-05 records; compromised keys should be announced via a signed "key compromised" event (kind 0 update or relay broadcast) so peers can reject sessions signed by the old key. WebAuthn credentials are ephemeral per-session, so rotation/revocation is not applicable.

## Error Handling & Graceful Degradation
If signer app is unavailable (extension not installed, NIP-46 relay unreachable, WebAuthn cancelled), fall back to ephemeral mode with a clear warning: "Identity verification unavailable - proceeding without signature." Retry NIP-46 connections up to 3 times with exponential backoff before showing "Signer unreachable" error.

## Consent Flow
All signing requests must show a user-visible prompt with session details (file name, peer npub if known, timestamp); for NIP-46 remote signing, display "Waiting for approval on signer device..." with a 60-second timeout that auto-cancels with "Signing request timed out or denied."

## Integration with SS02
Session signing is additive to existing SS02 flow: generate ECDH keypair first, then sign the ECDH public key + metadata, and include signature in the QR payload. The ECDH shared secret derivation and AES-256-GCM encryption remain unchanged; signing only authenticates the key exchange, it does not replace encryption. SS02 payloads without signatures remain valid for backward compatibility.

---

# Implementation Priority (Suggested)

1. **NIP-07 Extension** - Simplest, leverages existing Nostr ecosystem. Start here because the browser extension ecosystem (Alby, nos2x) already exists, enabling fast integration with minimal new code.

2. **Nostr-Signed QR (Enhancement A)** - Identity verification with familiar QR flow. Prioritize next because it reuses the existing QR UX users already understand, requiring only payload extension rather than new infrastructure.

3. **NIP-46 Remote Signing** - Cross-device, mobile support. Worth the added protocol complexity because it unlocks mobile signer apps (Amber) and cross-device workflows that NIP-07 cannot provide.

4. **Nostr Relay Push (Enhancement B)** - Remote transfers without QR. Useful for transferring to known contacts remotely, but requires relay coordination and recipient npub discovery, making it a later addition.

5. **WebAuthn** - Hardware-backed, but lower priority due to setup friction. Deferred because it requires authenticator hardware, provides only device-bound identity (not portable npub), and offers less ecosystem integration than Nostr-based options.
