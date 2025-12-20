# WebAuthn Session Signing Implementation Plan

## Overview

Add a new advanced manual option that uses **WebAuthn ephemeral credentials** for session signing between sender and receiver. This provides hardware-backed authentication while preserving ECDH for forward-secret key exchange.

## Design Decisions (from user)
- **Auth flow**: QR/manual exchange (similar to existing manual mode)
- **WebAuthn role**: Sign session data (ECDH still used for key exchange)
- **Credential type**: Ephemeral per session (privacy-preserving)

## Flow Comparison

**Existing Manual (SS02):**
```
Sender: ECDH keypair → QR(ECDH pubkey + SDP) → Receiver
Receiver: ECDH keypair → QR(ECDH pubkey + SDP) → Sender
Both: Derive shared secret via ECDH
```

**New WebAuthn (SS03):**
```
Sender: WebAuthn credential → Sign(ECDH pubkey + timestamp) → QR(sig + cred + ECDH + SDP) → Receiver
Receiver: Verify sender sig → WebAuthn credential → Sign(...) → QR(sig + cred + ECDH + SDP) → Sender
Sender: Verify receiver sig → Both derive shared secret via ECDH
```

## Implementation Steps

### 1. Create WebAuthn Crypto Module
**New file: `/src/lib/crypto/webauthn.ts`**

```typescript
// Key exports:
- isWebAuthnAvailable(): boolean
- createEphemeralCredential(): Promise<WebAuthnCredentialData>
- signSessionData(credentialId, sessionData): Promise<WebAuthnSignature>
- verifySessionSignature(peerCredential, peerSignature, expectedData): Promise<boolean>
```

Key details:
- Use `attestation: 'none'` (no hardware verification needed)
- Use `residentKey: 'discouraged'` (don't save to authenticator)
- Use ES256 (-7) algorithm for P-256 compatibility
- Challenge = SHA-256(canonical session JSON)
- All keys `extractable: false` per CLAUDE.md

### 2. Extend Signaling Payload Format
**Modify: `/src/lib/manual-signaling.ts`**

- Add new magic header: `SS03` (0x53, 0x53, 0x30, 0x33)
- Extend `SignalingPayload` interface with optional `webauthn` field:
  ```typescript
  webauthn?: {
    credentialId: number[]
    publicKey: number[]           // COSE format
    publicKeyAlgorithm: number    // -7 for ES256
    signature: {
      authenticatorData: number[]
      signature: number[]
      clientDataJSON: number[]
    }
  }
  ```
- Add `generateWebAuthnOfferBinary()`, `generateWebAuthnAnswerBinary()`
- Add `parseWebAuthnPayload()`, `isWebAuthnPayload()`

### 3. Update PIN Constants
**Modify: `/src/lib/crypto/constants.ts`**

- Add `WEBAUTHN_FIRST_CHARSET = '3'` for method detection
- Existing: uppercase=Nostr, lowercase=PeerJS, '2'=Manual, '3'=WebAuthn

### 4. Create WebAuthn Send Hook
**New file: `/src/hooks/use-webauthn-send.ts`**

Follow `use-manual-send.ts` pattern with additions:
- New status: `'creating_credential'`, `'verifying_signature'`
- State includes `webauthnVerified?: boolean`
- Flow:
  1. Create ephemeral WebAuthn credential
  2. Generate ECDH keypair
  3. Sign session data (ECDH pubkey + timestamp + metadata)
  4. Create WebRTC offer + collect ICE
  5. Show QR/clipboard (SS03 format)
  6. Receive answer, verify WebAuthn signature
  7. Derive shared secret, proceed with transfer

### 5. Create WebAuthn Receive Hook
**New file: `/src/hooks/use-webauthn-receive.ts`**

Follow `use-manual-receive.ts` pattern with additions:
- New status: `'verifying_signature'`, `'creating_credential'`
- Flow:
  1. Receive offer (detect SS03)
  2. Verify sender's WebAuthn signature
  3. Create own ephemeral credential
  4. Sign session data
  5. Generate answer with credential + signature
  6. Derive shared secret, receive transfer

### 6. UI Integration
**Modify: `/src/components/secure-send/send-tab.tsx`**

- Add `'webauthn-only'` to `ForcedMethod` type
- Add radio option with Fingerprint icon (disabled if `!isWebAuthnAvailable()`)
- Show verification status badge when `state.webauthnVerified`

**Modify: `/src/components/secure-send/receive-tab.tsx`**

- Add `'webauthn'` to `ReceiveMode` type
- Add tab with Fingerprint icon
- Show sender verification status

**Modify: `/src/components/secure-send/qr-input.tsx`**

- Update validation to accept both SS02 and SS03 formats

### 7. Update Types
**Modify: `/src/lib/nostr/types.ts`**

- Add `'webauthn'` to `SignalingMethod` union type

## Files to Create
- `/src/lib/crypto/webauthn.ts`
- `/src/hooks/use-webauthn-send.ts`
- `/src/hooks/use-webauthn-receive.ts`

## Files to Modify
- `/src/lib/manual-signaling.ts`
- `/src/lib/crypto/constants.ts`
- `/src/components/secure-send/send-tab.tsx`
- `/src/components/secure-send/receive-tab.tsx`
- `/src/components/secure-send/qr-input.tsx`
- `/src/lib/nostr/types.ts`

## Error Handling
- Detect WebAuthn availability, disable option if unavailable
- Handle user cancellation of authenticator prompt
- Signature verification failure = abort transfer with clear error
- 60-second timeout for credential creation

## Security Notes
- Ephemeral credentials provide no cross-session linkability
- Forward secrecy via ECDH (WebAuthn only authenticates)
- Challenge binding prevents replay attacks
- `extractable: false` on all crypto keys

---

# Alternative Approach: External Signer (Nostr/Wallet Pattern)

## Concept

Similar to how crypto wallets (MetaMask, WalletConnect) work - use an external app (browser extension, mobile app, or desktop app) to sign session data **without exposing the private key to the browser**.

## Why This Approach?

| WebAuthn | External Signer |
|----------|-----------------|
| Requires physical authenticator | Works with any device running signer app |
| Ephemeral credentials only | Can use persistent identity (optional) |
| Limited to local device | Can sign remotely (phone signs for laptop) |
| No cross-device identity | Same identity across devices |

## Nostr Signing Protocols

### Option A: NIP-07 (Browser Extension)
**Like MetaMask for Nostr**

```
Browser Extension (nos2x, Alby, etc.)
    ↓ holds private key
    ↓ exposes window.nostr API
Web App calls window.nostr.signEvent(event)
    ↓ extension prompts user
    ↓ returns signature
```

**Pros:**
- Simple API, widely supported
- Private key never leaves extension
- Works with existing Nostr extensions

**Cons:**
- Requires browser extension installation
- Desktop-only (no mobile)

**Implementation:**
```typescript
// Check for NIP-07 extension
if (window.nostr) {
  const pubkey = await window.nostr.getPublicKey()
  const signedEvent = await window.nostr.signEvent({
    kind: 24244, // custom kind for secure-send session
    content: JSON.stringify({ ecdhPubkey, timestamp, metadata }),
    created_at: Math.floor(Date.now() / 1000),
    tags: []
  })
}
```

### Option B: NIP-46 (Nostr Connect / Remote Signer)
**Like WalletConnect for Nostr**

```
Mobile/Desktop Signer App (e.g., Amber, nsec.app)
    ↓ holds private key
    ↓ connects via Nostr relay or direct
Web App ←→ Encrypted channel ←→ Signer
    ↓ sends signing request
    ↓ signer prompts user
    ↓ returns signature via relay
```

**Flow:**
1. Web app displays QR code with `nostrconnect://` URI or `bunker://` URI
2. User scans with signer app (Amber, nsec.app, etc.)
3. Encrypted session established via Nostr relay
4. Web app sends signing requests
5. Signer app prompts, signs, returns signature

**Pros:**
- Works cross-device (sign on phone for laptop session)
- Mobile-friendly
- Private key on secure device
- Can use same identity across sessions

**Cons:**
- Requires relay connectivity for some flows
- More complex setup
- Depends on signer app ecosystem

**Implementation:**
```typescript
// Generate connection URI
const connectURI = `nostrconnect://${signerPubkey}?relay=${relayUrl}&metadata=${encodeURIComponent(appMetadata)}`

// Or bunker URI for existing connection
const bunkerURI = `bunker://${signerPubkey}?relay=${relayUrl}&secret=${sharedSecret}`

// Display as QR, user scans with Amber/nsec.app
// After connection, request signature:
await nostrConnect.signEvent({
  kind: 24244,
  content: sessionDataJSON,
  // ...
})
```

### Option C: NIP-55 (Android Intent Signer)
**Native Android integration**

```
Android App (Amber)
    ↓ registered as signer intent handler
Web App → Android Intent → Signer App
    ↓ prompts user
    ↓ returns signature via intent result
```

**Pros:**
- Native Android UX
- No relay needed
- Fast, local signing

**Cons:**
- Android only
- Requires compatible signer app

## Proposed Hybrid Approach: "Signer Mode"

Combine multiple signing backends with a unified interface:

```typescript
interface SessionSigner {
  type: 'nip07' | 'nip46' | 'nip55' | 'webauthn' | 'ephemeral'
  getPublicKey(): Promise<string>
  signSessionData(data: SessionData): Promise<SignedSessionData>
  verifySignature(signedData: SignedSessionData): Promise<boolean>
}

// Auto-detect available signers
async function detectSigners(): Promise<SessionSigner[]> {
  const signers: SessionSigner[] = []

  if (window.nostr) signers.push(new NIP07Signer())
  if (isWebAuthnAvailable()) signers.push(new WebAuthnSigner())
  signers.push(new EphemeralSigner()) // always available fallback

  return signers
}
```

## Flow: NIP-46 Session Signing

```
┌─────────────────────────────────────────────────────────────────┐
│                         SENDER                                   │
├─────────────────────────────────────────────────────────────────┤
│ 1. Generate ECDH keypair (in browser, ephemeral)                │
│ 2. Show QR: nostrconnect://... or bunker://...                  │
│ 3. User scans with signer app (Amber, etc.)                     │
│ 4. Request signature: sign({ ecdhPubkey, timestamp, fileInfo }) │
│ 5. Signer app prompts, user approves                            │
│ 6. Receive signature + signer pubkey                            │
│ 7. Generate offer QR: SS04(ECDH + sig + signerPubkey + SDP)     │
└─────────────────────────────────────────────────────────────────┘
                              ↓ QR
┌─────────────────────────────────────────────────────────────────┐
│                        RECEIVER                                  │
├─────────────────────────────────────────────────────────────────┤
│ 1. Scan offer QR                                                │
│ 2. Verify sender's Nostr signature (using signerPubkey)         │
│ 3. Display: "Sender identity: npub1..." for user verification   │
│ 4. Connect own signer (QR or already connected)                 │
│ 5. Generate ECDH keypair                                        │
│ 6. Sign session data with own signer                            │
│ 7. Generate answer QR: SS04(ECDH + sig + signerPubkey + SDP)    │
└─────────────────────────────────────────────────────────────────┘
                              ↓ QR
┌─────────────────────────────────────────────────────────────────┐
│                      SENDER (continued)                          │
├─────────────────────────────────────────────────────────────────┤
│ 8. Scan answer QR                                               │
│ 9. Verify receiver's Nostr signature                            │
│ 10. Display: "Receiver identity: npub1..."                      │
│ 11. Derive ECDH shared secret → AES key                         │
│ 12. Establish WebRTC, transfer encrypted file                   │
└─────────────────────────────────────────────────────────────────┘
```

## Comparison Matrix

| Feature | WebAuthn | NIP-07 | NIP-46 | Ephemeral |
|---------|----------|--------|--------|-----------|
| Private key location | Authenticator | Extension | External app | Browser |
| Cross-device signing | No | No | Yes | No |
| Persistent identity | Optional | Yes | Yes | No |
| Mobile support | Yes* | No | Yes | Yes |
| Offline capable | Yes | Yes | No** | Yes |
| Setup required | Authenticator | Extension | Signer app | None |
| Identity verification | Device-bound | Nostr pubkey | Nostr pubkey | None |

*Platform authenticator or security key
**Can work offline with local signer via NIP-55

## Recommended Implementation Order

1. **Phase 1: WebAuthn** (as planned above)
   - Hardware-backed, no external dependencies
   - Works offline
   - Good baseline security

2. **Phase 2: NIP-07 Extension Support**
   - Simple integration (`window.nostr`)
   - Leverages existing Nostr ecosystem
   - Desktop users with extensions

3. **Phase 3: NIP-46 Remote Signing**
   - Full cross-device support
   - Mobile signer apps (Amber)
   - Most flexible but complex

## Security Considerations

### Identity Verification
With Nostr signing, users can verify counterparty identity:
- Display `npub1...` or NIP-05 identifier
- User can confirm out-of-band ("Is your npub xyz...?")
- Optional: contact list / web-of-trust verification

### Key Separation
- **ECDH keys**: Always ephemeral, generated in browser, used for forward secrecy
- **Signing keys**: Long-lived, held by external signer, used for authentication only
- Compromise of signing key doesn't reveal past session content

### Replay Prevention
- Timestamp in signed data
- Unique session ID / nonce
- Short validity window (e.g., 5 minutes)
