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
