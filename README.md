# Secure Send

A web application for sending encrypted text messages and files using PIN-based signaling protection and optional cloud encryption. Uses WebRTC for direct P2P connections with cloud fallback.

**Demo:** [https://securesend.kuvi.app/](https://securesend.kuvi.app/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **Works offline**: No internet required after page load when using Manual Exchange on same local network
- **Flexible signaling**: Nostr (default) or Manual Exchange (QR/copy-paste). Manual Exchange works across networks with internet, or on same local network without internet.
- **PIN-based security**: All signaling payloads are encrypted with the PIN
- **Passkey support**: Use synced passkeys (1Password, iCloud Keychain, Google Password Manager) for passwordless encryption - no PIN memorization needed
- **File or folder transfer**: Send files or folders up to 100MB
- **End-to-end encryption**: All transfers use AES-256-GCM encryption
- **No accounts required**: Ephemeral keypairs generated per transfer
- **PWA Support**: Install as a Progressive Web App for offline access

## How It Works

### Sending a Text Message

1. Select the "Text Message" tab
2. Enter your message (up to 100MB)
3. Click "Generate PIN & Send"
4. Share the generated 12-character PIN or its 7-word equivalent with the receiver through another channel (voice, chat, etc.)
5. Wait for the receiver to connect and receive the message

### Sending a File

1. Select the "File" tab
2. Drag and drop a file or click to select (max 100MB)
3. Click "Generate PIN & Send"
4. Share the generated 12-character PIN (or 7-word equivalent) with the receiver
5. Wait for the receiver to connect and receive the file

### Receiving

1. Enter the PIN or the 7-word sequence shared by the sender (signaling method is auto-detected)
2. Click "Receive"
3. For text: View and copy the decrypted message
4. For files: Click "Download File" to save

## Security

- **PBKDF2-SHA256** with 600,000 iterations for key derivation (browser-compatible)
- **AES-256-GCM** authenticated encryption
- **PIN never transmitted**: Only a hash hint is visible to relays
- **Passkey security**: Keys derived via WebAuthn PRF extension from device secure hardware (Touch ID, Face ID, Windows Hello, etc.)
- **Ephemeral identities**: New Nostr keypairs generated per transfer
- **1-hour expiration**: PIN exchange events expire automatically
- **QR signaling encryption**: QR payloads are encrypted with the PIN before encoding

## Tech Stack

- React 19 + TypeScript
- Vite
- Tailwind CSS + shadcn/ui
- nostr-tools for Nostr protocol
- Web Crypto API for cryptographic operations

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

### Hash Routing (Static Hosting)

For hosts that require hash-based routing (e.g. no server rewrites), build with:

```bash
VITE_USE_HASH=true npm run build
```

You can also create `.env.production` (or `.env.hash` with `npm run build -- --mode hash`) containing:

```
VITE_USE_HASH=true
```

## Transport Layer

All signaling methods share a **unified encryption layer**: content is encrypted in 128KB AES-256-GCM chunks before transmission, regardless of transport. Receivers preallocate buffers and write directly to position for memory efficiency.

**Signaling Methods** (sender chooses):
- **Nostr** (default): Requires internet. Decentralized relay signaling. Devices can be on different networks. Has cloud fallback.
- **Manual Exchange**: No internet required. Exchange signaling via QR scan or copy/paste (camera optional). With internet, works across different networks. Without internet, devices must be on same local network.

**Data Transfer**: WebRTC P2P preferred; cloud fallback available in Nostr mode only.

See [Architecture](./docs/ARCHITECTURE.md) for detailed transfer flows and encryption specifics.

### PIN Auto-Detection

The signaling method and authentication mode are encoded in the PIN's first character:
- **Uppercase letter** (A-Z): Nostr signaling with PIN
- **Digit "2"**: Manual exchange (QR or copy/paste)
- **Letter "P"**: Passkey mode (no PIN needed)

Receivers don't need to select a signaling method - it's automatically detected from the PIN.

### Passkey Mode

Passkeys provide passwordless encryption using the WebAuthn PRF extension:

1. **Setup**: Create a passkey at `/passkey` - it's stored in your password manager (1Password, iCloud Keychain, Google Password Manager, etc.)
2. **Self-transfer**: Same passkey synced via password manager - encryption works automatically
3. **Cross-user transfer**: Exchange a pairing key with your peer (see below)
4. **Send/Receive**: Enable "Use Passkey" in Advanced Options and authenticate with biometrics/device unlock

**Key differences from PIN mode:**
- No PIN to memorize or share
- Encryption keys derived from WebAuthn PRF extension (hardware-backed)
- Fingerprint (16-char identifier) for verification
- Same AES-256-GCM encryption strength as PIN mode

### Pairing Keys (Cross-User Passkey Mode)

When using passkey mode with a different person (cross-user), you need a **pairing key** - a cryptographic proof that both parties have agreed to communicate:

**How to create a pairing key:**

1. **Exchange Identity Cards**: On the `/passkey` page, copy your Identity Card (JSON with your public ID and peer key) and share it with your peer
2. **Create & Send Pairing Request**: Paste your peer's card and click "Sign" to create and share the pairing request (signed by you)
3. **Complete Pairing Key**: Your peer pastes the pairing request and clicks "Confirm" to complete it
4. **Use Pairing Key**: The completed pairing key (with both signatures) is used by both parties for transfers

**Pairing flow:**
```
Alice (Initiator)                    Bob (Confirmer)
      |                                     |
      |  1. Exchange Identity Cards         |
      v                                     v
 Create pairing request                     |
      |                                     |
      |  2. Pairing request --------------->|
      |                                     v
      |                          Confirm pairing
      |                                     |
      |<-------------- 3. Complete pairing key
      |                                     |
      v                                     v
 +---------------------------------------------+
 |  SAME PAIRING KEY - Either can send/receive |
 +---------------------------------------------+
```

**Security properties:**
- Both parties compute HMAC-SHA256 MACs over the same challenge (tamper-proof)
- Each party's HMAC key is derived from their passkey PRF (non-extractable, protected by passkey authentication)
- Pairing key contains both parties' public IDs, peer public keys, and verification secrets
- Each party can verify their own MAC by re-authenticating to derive their HMAC key
- Peer's MAC cannot be verified cryptographically (no access to their key) - trust is established via out-of-band fingerprint verification during identity card exchange
- **Handshake Proofs (HP)** provide runtime authentication: both parties prove passkey control at every handshake, preventing impersonation with stolen pairing keys
- **Only the two parties in the pairing key can use it** - party membership is cryptographically verified during the handshake; a third party cannot use someone else's pairing key

### Cloud Storage Redundancy

Upload servers and CORS proxies with automatic failover:

**Upload Servers:**
- tmpfiles.org
- litterbox.catbox.moe (1h expiration, upload via CORS proxy)
- uguu.se
- x0.at

**CORS Proxies (for download):**
- Direct download (for litterbox URLs)
- corsproxy.io
- cors.leverson83.org
- api.codetabs.com
- cors-anywhere.com
- api.allorigins.win

## Debug

### Test Cloud Services

Test cloud service availability from browser console:

```javascript
await window.testCloudServices()
```

This tests all CORS proxies and upload servers, showing latency and status for each.

### Force Cloud-Only Transfer

Disable P2P and force cloud transfer for testing:

```javascript
// Enable cloud-only mode (disable WebRTC P2P)
testCloudTransfer(true)

// Disable cloud-only mode (back to P2P-first)
testCloudTransfer(false)
```

When enabled, a "Cloud-only mode" indicator appears in the UI.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Technical architecture and design decisions
- [Roadmap](./docs/ROADMAP.md) - Completed and planned features

## License

MIT
