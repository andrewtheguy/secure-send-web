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

| Feature | WebAuthn/Passkeys | NIP-07 | NIP-46 | Ephemeral |
|---------|-------------------|--------|--------|-----------|
| **Ecosystem** | **Mainstream** (billions of devices) | Niche (~thousands) | Very niche | Universal |
| Private key location | Platform/1Password/Security Key | Browser extension | External app | Browser |
| Cross-device sync | **Yes** (iCloud/Google/1Password) | No | Yes | No |
| Persistent identity | Credential ID | Yes (npub) | Yes (npub) | No |
| Mobile support | **Yes** (native) | No | Yes | Yes |
| Desktop support | **Yes** (native) | Yes (extension) | Yes | Yes |
| Offline capable | Yes | Yes | No* | Yes |
| Setup required | **None** (built-in) | Extension install | Signer app | None |

*Can work offline with local signer via NIP-55

### Ecosystem Reality

| Platform | WebAuthn/Passkeys | Nostr |
|----------|-------------------|-------|
| iOS/iPadOS | Native (Keychain, Face ID, Touch ID) | No built-in support |
| macOS | Native (Keychain, Touch ID) | No built-in support |
| Windows | Native (Windows Hello) | No built-in support |
| Android | Native (biometrics, Google Password Manager) | Amber app only |
| Chrome | Built-in + extension support | Extension required (nos2x, Alby) |
| Safari | Built-in | Extension required |
| 1Password | Full passkey support with sync | None |
| Bitwarden | Full passkey support | None |

---

# Option 1: WebAuthn/Passkey Session Signing (Recommended)

## Concept

Use WebAuthn (FIDO2) passkeys to sign session data. Provides hardware-backed authentication with the widest ecosystem support - works on virtually every modern device without any setup.

## Supported Authenticators

**Platform Authenticators (Zero Setup):**
- **iOS/iPadOS**: Face ID, Touch ID via iCloud Keychain
- **macOS**: Touch ID, iCloud Keychain passkeys
- **Windows**: Windows Hello (face, fingerprint, PIN)
- **Android**: Fingerprint, face unlock, Google Password Manager

**Password Managers (Cross-Device Sync):**
- **1Password**: Full passkey support, syncs across all devices
- **Bitwarden**: Passkey storage and sync
- **Dashlane**: Passkey support

**Security Keys:**
- YubiKey, Google Titan, Feitian, SoloKeys

## Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ SENDER                                                          │
├─────────────────────────────────────────────────────────────────┤
│ 1. Generate ephemeral ECDH keypair                              │
│ 2. Create WebAuthn credential                                   │
│    → Prompts: Touch ID / Face ID / 1Password / Windows Hello    │
│ 3. Sign session data via navigator.credentials.get():           │
│    challenge = SHA-256(ECDH pubkey + timestamp + nonce)         │
│ 4. Create QR: SS03(ECDH + signature + authenticatorData +       │
│               clientDataJSON + credentialPublicKey + SDP)       │
└─────────────────────────────────────────────────────────────────┘
                              ↓ Show QR / Paste
┌─────────────────────────────────────────────────────────────────┐
│ RECEIVER                                                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. Scan QR, extract signature + authenticatorData + publicKey   │
│ 2. Reconstruct clientDataJSON, verify signature                 │
│ 3. Display: "Session signed by [authenticator]"                 │
│ 4. User confirms sender identity (out-of-band if needed)        │
│ 5. Create own credential, sign answer with same flow            │
│ 6. Return signed answer QR                                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ SENDER                                                          │
├─────────────────────────────────────────────────────────────────┤
│ 1. Verify receiver's signature                                  │
│ 2. Derive shared secret via ECDH                                │
│ 3. Begin encrypted file transfer                                │
└─────────────────────────────────────────────────────────────────┘
```

## Pros
- **Widest availability**: Works on billions of devices out of the box
- **Zero setup**: No extensions, apps, or accounts needed
- **Hardware-backed**: Secure enclave, TPM, or security key
- **Cross-device sync**: 1Password/iCloud/Google sync passkeys
- **Works offline**: No network required for signing
- **Privacy-preserving**: Ephemeral credentials, no tracking

## Cons
- No persistent "social" identity (unlike Nostr npub)
- Credential ID is opaque (can verify "same credential" but not "who")
- PRF extension support varies by authenticator

## WebAuthn PRF Extension

The PRF (Pseudo-Random Function) extension allows deriving deterministic secrets from passkeys:

```typescript
const assertion = await navigator.credentials.get({
  publicKey: {
    challenge: sessionChallenge,
    allowCredentials: [{ id: credentialId, type: "public-key" }],
    extensions: {
      prf: {
        eval: {
          first: new TextEncoder().encode("secure-send-session-v1")
        }
      }
    }
  }
});
// assertion.getClientExtensionResults().prf.results.first → 32-byte secret
```

This can be used to derive session-specific encryption keys bound to the passkey.

## Implementation

```typescript
// Step 1: Create credential for this session
const credential = await navigator.credentials.create({
  publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "Secure Send", id: location.hostname },
    user: {
      id: crypto.getRandomValues(new Uint8Array(16)),
      name: "session",
      displayName: "Session Signer"
    },
    pubKeyCredParams: [
      { alg: -7, type: "public-key" },   // ES256 (P-256)
      { alg: -257, type: "public-key" }  // RS256 fallback
    ],
    authenticatorSelection: {
      residentKey: "discouraged",        // Don't clutter passkey list
      userVerification: "preferred"
    },
    attestation: "none"                  // No attestation needed
  }
});

// Extract public key for signature verification
const publicKeyBytes = credential.response.getPublicKey();

// Step 2: Sign session data (ECDH pubkey + metadata)
const sessionData = {
  ecdhPublicKey: ecdhPubKeyBase64,
  timestamp: Date.now(),
  nonce: crypto.getRandomValues(new Uint8Array(16))
};
const sessionBytes = new TextEncoder().encode(JSON.stringify(sessionData));
const sessionHash = await crypto.subtle.digest("SHA-256", sessionBytes);

const assertion = await navigator.credentials.get({
  publicKey: {
    challenge: new Uint8Array(sessionHash),
    allowCredentials: [{
      id: credential.rawId,
      type: "public-key"
    }],
    userVerification: "preferred"
  }
});

// Step 3: Package for QR
const signedPayload = {
  version: "SS03",
  ecdh: ecdhPubKeyBase64,
  sdp: offerSDP,
  webauthn: {
    credentialId: base64url(credential.rawId),
    publicKey: base64url(publicKeyBytes),
    signature: base64url(assertion.response.signature),
    authenticatorData: base64url(assertion.response.authenticatorData),
    clientDataJSON: base64url(assertion.response.clientDataJSON)
  }
};
```

## Verification (Receiver Side)

```typescript
async function verifyWebAuthnSignature(payload: SignedPayload): Promise<boolean> {
  const { webauthn, ecdh } = payload;

  // Reconstruct what was signed
  const clientData = JSON.parse(
    new TextDecoder().decode(base64urlDecode(webauthn.clientDataJSON))
  );

  // Verify challenge matches session data hash
  const expectedSessionData = {
    ecdhPublicKey: ecdh,
    timestamp: clientData.timestamp,
    nonce: clientData.nonce
  };
  const expectedHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(expectedSessionData))
  );

  if (base64url(new Uint8Array(expectedHash)) !== clientData.challenge) {
    return false; // Challenge mismatch
  }

  // Import public key and verify signature
  const publicKey = await crypto.subtle.importKey(
    "spki",
    base64urlDecode(webauthn.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );

  // WebAuthn signature is over: authenticatorData || SHA-256(clientDataJSON)
  const clientDataHash = await crypto.subtle.digest(
    "SHA-256",
    base64urlDecode(webauthn.clientDataJSON)
  );
  const signedData = concatenate(
    base64urlDecode(webauthn.authenticatorData),
    new Uint8Array(clientDataHash)
  );

  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    base64urlDecode(webauthn.signature),
    signedData
  );
}
```

## Implementation Notes
- Payload format: SS03
- Use `attestation: 'none'` - we don't need to verify authenticator make/model
- Use `residentKey: 'discouraged'` - don't clutter user's passkey list
- ES256 (P-256) algorithm for Web Crypto compatibility
- All keys `extractable: false` per CLAUDE.md

---

# Option 2: NIP-07 Extension Signing (Nostr - Niche)

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

# Option 3: NIP-46 Remote Signing (Nostr - Niche)

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

# Option 4: NIP-55 Android Intent Signing (Nostr - Niche)

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

# Enhancement A: Nostr-Signed QR Exchange (Nostr - Niche)

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

# Enhancement B: Nostr Relay Push (Nostr - Niche)

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
  // WebAuthn first - widest availability
  if (isWebAuthnAvailable()) signers.push(new WebAuthnSigner())
  // Nostr for users with extensions
  if (window.nostr) signers.push(new NIP07Signer())
  // Ephemeral always available as fallback
  signers.push(new EphemeralSigner())
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
- **WebAuthn**: Display credential ID fingerprint or "Signed by [authenticator type]"
- **Nostr**: Display `npub1...` or NIP-05 for user verification
- Out-of-band confirmation ("Is your credential/npub xyz...?")
- Optional: web-of-trust / contact list (Nostr only)

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

# Implementation Priority

1. **WebAuthn/Passkeys** - Recommended first choice. Widest ecosystem availability (billions of devices), zero user setup required, hardware-backed security. Works with Touch ID, Face ID, Windows Hello, 1Password, security keys out of the box. Password managers like 1Password provide cross-device sync, solving the "device-bound" limitation.

2. **Ephemeral (current SS02)** - Always available fallback. No identity verification but works everywhere. Continue supporting for users who decline or can't use WebAuthn.

3. **NIP-07 Extension** - For Nostr-native users. If the user already has nos2x or Alby installed, this provides npub-based identity. Niche but valuable for the Nostr community.

4. **NIP-46 Remote Signing** - For advanced Nostr users. Cross-device signing via relay for users with Amber or nsec.app. More complex setup but enables mobile signing for desktop sessions.

5. **Nostr Relay Push (Enhancement B)** - Future enhancement. Remote transfers to known npubs without QR scanning. Requires relay infrastructure and recipient discovery.

## Why WebAuthn First?

| Consideration | WebAuthn | Nostr (NIP-07/46) |
|---------------|----------|-------------------|
| User base | Billions (every modern device) | Thousands (niche) |
| Setup required | None | Extension/app install |
| Mobile support | Native | Limited (NIP-46 only) |
| Cross-device | Yes (1Password, iCloud, Google) | Yes (NIP-46) |
| Identity type | Credential ID (opaque) | npub (social) |

WebAuthn is the pragmatic choice for maximum reach. Nostr options remain for users who value npub-based social identity.

---

# Enhancement C: Passkey as PIN Alternative for Encryption

## Concept

Use WebAuthn PRF extension to derive encryption keys instead of requiring users to enter a PIN or password. The passkey becomes the "something you have + something you are" factor that unlocks encryption.

## Comparison: PIN vs Passkey

| Aspect | PIN/Password | Passkey (PRF) |
|--------|--------------|---------------|
| User experience | Type characters | Touch ID / Face ID / tap |
| Phishing resistance | Low (can be stolen) | High (bound to origin) |
| Brute force resistance | Depends on length | Hardware-backed |
| Key derivation | PBKDF2/Argon2 from PIN | PRF from authenticator |
| Cross-device | Yes (memorized) | Yes (synced passkeys) |
| Offline access | Yes | Yes |
| Recovery | Remember PIN | Passkey recovery flow |

## Use Cases in Secure-Send

### 1. Encrypt Saved Sessions
```
Without passkey: Enter PIN → PBKDF2 → AES key → Encrypt session data
With passkey:    Touch ID → PRF → AES key → Encrypt session data
```

### 2. Protect QR Payload (Offline Transfer)
```
Sender: Passkey PRF → Encrypt(ECDH pubkey + SDP) → QR
Receiver: Scan QR → Own passkey PRF → Decrypt → Establish connection
```

### 3. Encrypt Files Before Transfer
```
Sender: Passkey PRF → AES key → Encrypt file → Transfer
Receiver: Own passkey PRF → Derive same key (via key exchange) → Decrypt
```

## Flow: Passkey Replaces PIN

```
┌─────────────────────────────────────────────────────────────────┐
│ TRADITIONAL PIN FLOW                                            │
├─────────────────────────────────────────────────────────────────┤
│ 1. User enters PIN: "1234"                                      │
│ 2. Derive key: PBKDF2(PIN, salt, 100000) → 256-bit key         │
│ 3. Encrypt/decrypt data with derived key                        │
│                                                                  │
│ Problems:                                                        │
│ - Weak PINs are common                                          │
│ - Shoulder surfing                                               │
│ - Phishing (fake PIN prompt)                                    │
│ - Brute force if salt is known                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PASSKEY PRF FLOW                                                │
├─────────────────────────────────────────────────────────────────┤
│ 1. User authenticates: Touch ID / Face ID / Windows Hello       │
│ 2. PRF derives key: PRF(credentialKey, salt) → 256-bit key     │
│ 3. Encrypt/decrypt data with derived key                        │
│                                                                  │
│ Advantages:                                                      │
│ - No weak passwords                                              │
│ - Biometric or hardware token required                          │
│ - Phishing-resistant (origin-bound)                             │
│ - Hardware-backed key derivation                                │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation

### Create Encryption Credential

```typescript
// One-time setup: create a passkey for encryption
async function createEncryptionPasskey(): Promise<PublicKeyCredential> {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Secure Send", id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "encryption-key",
        displayName: "Secure Send Encryption"
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      authenticatorSelection: {
        residentKey: "required",        // Discoverable for convenience
        userVerification: "required"    // Always require biometric/PIN
      },
      extensions: {
        prf: {}  // Enable PRF extension
      }
    }
  });

  // Check if PRF is supported
  const extResults = credential.getClientExtensionResults();
  if (!extResults.prf?.enabled) {
    throw new Error("Authenticator does not support PRF extension");
  }

  // Store credential ID for future use
  localStorage.setItem("encryptionCredentialId",
    base64url(credential.rawId));

  return credential;
}
```

### Derive Encryption Key

```typescript
// Derive AES-256-GCM key from passkey
async function deriveEncryptionKey(
  salt: string = "secure-send-encryption-v1"
): Promise<CryptoKey> {
  const credentialId = localStorage.getItem("encryptionCredentialId");
  if (!credentialId) {
    throw new Error("No encryption passkey configured");
  }

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{
        id: base64urlDecode(credentialId),
        type: "public-key"
      }],
      userVerification: "required",
      extensions: {
        prf: {
          eval: {
            first: new TextEncoder().encode(salt)
          }
        }
      }
    }
  });

  const prfResult = assertion.getClientExtensionResults().prf;
  if (!prfResult?.results?.first) {
    throw new Error("PRF evaluation failed");
  }

  // Import as AES-256-GCM key
  return crypto.subtle.importKey(
    "raw",
    prfResult.results.first,
    { name: "AES-GCM" },
    false,  // extractable: false per CLAUDE.md
    ["encrypt", "decrypt"]
  );
}
```

### Encrypt/Decrypt Data

```typescript
async function encryptWithPasskey(data: Uint8Array): Promise<Uint8Array> {
  const key = await deriveEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  // Prepend IV to ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result;
}

async function decryptWithPasskey(encrypted: Uint8Array): Promise<Uint8Array> {
  const key = await deriveEncryptionKey();
  const iv = encrypted.slice(0, 12);
  const ciphertext = encrypted.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new Uint8Array(plaintext);
}
```

## Multiple Salts for Key Separation

Use different salts to derive separate keys for different purposes:

```typescript
const SALTS = {
  sessionEncryption: "secure-send-session-v1",
  fileEncryption: "secure-send-file-v1",
  localStorage: "secure-send-storage-v1",
  keyWrapping: "secure-send-wrap-v1"
};

// Each salt produces a different 256-bit key from the same passkey
const sessionKey = await deriveEncryptionKey(SALTS.sessionEncryption);
const fileKey = await deriveEncryptionKey(SALTS.fileEncryption);
```

## Fallback to PIN

For authenticators without PRF support, fall back to traditional PIN:

```typescript
async function getEncryptionKey(): Promise<CryptoKey> {
  // Try passkey first
  if (await hasPasskeyWithPRF()) {
    try {
      return await deriveEncryptionKey();
    } catch (e) {
      console.warn("Passkey failed, falling back to PIN", e);
    }
  }

  // Fallback: prompt for PIN
  const pin = await promptForPIN();
  const salt = getSavedSalt() || crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
```

## PRF Support Detection

```typescript
async function checkPRFSupport(): Promise<boolean> {
  // Check if WebAuthn is available
  if (!window.PublicKeyCredential) {
    return false;
  }

  // Check if PRF extension is supported by creating a test credential
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "PRF Test", id: location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: "test",
          displayName: "PRF Test"
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: {
          residentKey: "discouraged",
          userVerification: "discouraged"
        },
        extensions: { prf: {} }
      }
    });

    const extResults = credential.getClientExtensionResults();
    return extResults.prf?.enabled === true;
  } catch {
    return false;
  }
}
```

## Security Considerations

### Advantages over PIN
- **No weak secrets**: Key derived from hardware, not user-chosen password
- **Phishing resistant**: PRF bound to origin, can't be replayed elsewhere
- **No keyboard logging**: Biometric or hardware token, nothing to intercept
- **Hardware-backed**: Key derivation happens in secure enclave/TPM

### Considerations
- **Recovery**: If passkey is lost, data encrypted with it is unrecoverable
  - Mitigation: Allow multiple passkeys, or backup key escrow
- **Device binding**: Passkeys may be device-specific (unless synced)
  - Mitigation: Use synced passkeys (1Password, iCloud, Google)
- **PRF support**: Not all authenticators support PRF
  - Mitigation: Detect and fall back to PIN

### Key Rotation
To rotate the encryption key (e.g., after device compromise):
1. Decrypt all data with old passkey
2. Create new passkey with PRF
3. Re-encrypt all data with new passkey
4. Delete old passkey from authenticator

## UX Recommendations

1. **First-time setup**: "Protect with Face ID" button alongside traditional "Set PIN"
2. **Clear labeling**: "Unlock with passkey" vs "Enter PIN"
3. **Graceful fallback**: If passkey auth fails, offer PIN as backup
4. **Multiple passkeys**: Allow registering passkeys from multiple devices
5. **Recovery flow**: Clear instructions for passkey recovery via platform (iCloud, Google, 1Password)
