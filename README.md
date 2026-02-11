# Secure Send

A web application for sending encrypted files and folders with PIN-based or passkey-based Nostr signaling, plus optional cloud fallback. Uses WebRTC for direct P2P connections.

**Demo:** [https://securesend.kuvi.app/](https://securesend.kuvi.app/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **Works offline**: No internet required after page load when using Manual Exchange on same local network
- **Flexible signaling**: Nostr (default) or Manual Exchange (QR/copy-paste). Manual Exchange works across networks with internet, or on same local network without internet.
- **PIN-based security (Nostr)**: Nostr signaling payloads are encrypted with the PIN
- **Passkey support**: Use synced passkeys (1Password, iCloud Keychain, Google Password Manager) for passwordless encryption - no PIN memorization needed
- **File or folder transfer**: Send files or folders up to 100MB
- **End-to-end encryption**: All transfers use AES-256-GCM encryption
- **No accounts required**: Ephemeral keypairs generated per transfer
- **PWA Support**: Install as a Progressive Web App for offline access

## Version Compatibility (v0.0.x)

During `v0.0.x`, compatibility between different app versions is not guaranteed.
Sender and receiver should use the same app version for transfers.
The current app version is shown in the footer.

## How It Works

### Sending Files or Folders

1. Select the "File" or "Folder" tab
2. Drag and drop a file/folder or click to select (max 100MB total)
3. Click "Generate PIN & Send"
4. Share the generated 12-character PIN (or 7-word equivalent) with the receiver
5. Wait for the receiver to connect and receive the file

### Receiving

1. Enter the PIN or the 7-word sequence shared by the sender (signaling method is auto-detected)
2. Click "Receive"
3. Click "Download File" to save

## Security

- **PBKDF2-SHA256** with 600,000 iterations for key derivation (browser-compatible)
- **AES-256-GCM** authenticated encryption
- **PIN never transmitted (Nostr)**: Only a hash hint is visible to relays
- **Passkey security**: Keys derived via WebAuthn PRF extension from device secure hardware (Touch ID, Face ID, Windows Hello, etc.)
- **Ephemeral identities**: New Nostr keypairs generated per transfer
- **1-hour expiration**: PIN exchange events expire automatically
- **Manual exchange signaling**: QR payloads are time-bucketed obfuscated; file data is encrypted with ECDH-derived AES

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

### Routing (Required)

The app uses `BrowserRouter` only. Configure hosting to rewrite unknown paths to `index.html`.

### Deployment Path Requirement (Multi-QR Manual Mode)

Multi-QR URLs are generated from `window.location.origin` and then append `/r#d=...`.

- Supported: deployment at the domain root (for example `https://example.com`)
- Not supported: deployment under a subpath (for example `https://example.com/my-app`)

If the app is served from a subpath, scanned Multi-QR links will point to the domain root route and can 404.

## Transport Layer

All signaling methods share a **unified encryption layer**: P2P transfers encrypt content in 128KB AES-256-GCM chunks before transmission. Cloud fallback encrypts the whole file, then splits it into 10MB upload chunks.

**Signaling Methods** (sender chooses):
- **Nostr** (default): Requires internet. Decentralized relay signaling. Devices can be on different networks. Has cloud fallback.
- **Manual Exchange**: No internet required. Exchange signaling via QR scan or copy/paste (camera optional). With internet, works across different networks. Without internet, devices must be on same local network.

**Data Transfer**: WebRTC P2P preferred; cloud fallback available in Nostr mode only.

See [Architecture](./docs/ARCHITECTURE.md) for detailed transfer flows and encryption specifics.

### PIN Auto-Detection

The signaling method is encoded in the PIN's first character:
- **Uppercase letter** (A-Z): Nostr signaling
- **Digit "2"**: Manual exchange (QR or copy/paste)

Receivers don't need to select a signaling method - it's automatically detected from the PIN. Passkey mode uses fingerprints instead of PINs for identification.

### Passkey Mode (Self-Transfer)

Passkeys provide passwordless encryption using the WebAuthn PRF extension for transferring files to yourself across devices:

1. **Setup**: Create a passkey at `/passkey` - it's stored in your password manager (1Password, iCloud Keychain, Google Password Manager, etc.)
2. **Sync**: The same passkey syncs across your devices via your password manager
3. **Send/Receive**: Enable "Use Passkey" in Advanced Options and authenticate with biometrics/device unlock

**Key differences from PIN mode:**
- No PIN to memorize or share
- Encryption keys derived from WebAuthn PRF extension (hardware-backed)
- Fingerprint (16-char identifier) for verification
- Same AES-256-GCM encryption strength as PIN mode
- Perfect for sending files to yourself without sharing codes

### Cloud Storage Redundancy

Upload servers and CORS proxies with automatic failover:

**Upload Servers:**
- tmpfiles.org
- litterbox.catbox.moe (1h expiration, upload via CORS proxy; direct download)
- uguu.se
- x0.at

**CORS Proxies (for download):**
- corsproxy.io
- cors.leverson83.org
- api.codetabs.com
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
