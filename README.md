# Secure Send

A web application for sending encrypted text messages and files using PIN-based signaling protection and optional cloud encryption. Uses WebRTC for direct P2P connections with cloud fallback.

**Demo:** [https://secure-send-web.andrewtheguy.com/](https://secure-send-web.andrewtheguy.com/)

## Features

- **PIN-based security**: PIN encrypts signaling payloads so only the PIN holder can establish a connection
- **Text & file transfer**: Send text messages or files up to 100MB
- **WebRTC P2P**: Direct peer-to-peer connections for fast, efficient data transfer
- **Cloud fallback**: Falls back to cloud storage (tmpfiles.org) if WebRTC connection fails
- **End-to-end encryption**: All transfers use AES-256-GCM encryption with unique nonces per chunk, in addition to WebRTC DTLS
- **No accounts required**: Ephemeral keypairs are generated for each transfer
- **Multiple signaling methods**: Choose between Nostr relays (with cloud fallback), PeerJS (simpler P2P), or QR codes (works without internet)
- **Auto-detection**: Receiver automatically detects signaling method from PIN format

## How It Works

### Sending a Text Message

1. Select the "Text Message" tab
2. Enter your message (up to 100MB)
3. Click "Generate PIN & Send"
4. Share the generated 12-character PIN with the receiver through another channel (voice, chat, etc.)
5. Wait for the receiver to connect and receive the message

### Sending a File

1. Select the "File" tab
2. Drag and drop a file or click to select (max 100MB)
3. Click "Generate PIN & Send"
4. Share the generated 12-character PIN with the receiver
5. Wait for the receiver to connect and receive the file

### Receiving

1. Enter the PIN shared by the sender (signaling method is auto-detected from PIN)
2. Click "Receive"
3. For text: View and copy the decrypted message
4. For files: Click "Download File" to save

## Security

- **PBKDF2-SHA256** with 600,000 iterations for key derivation (browser-compatible)
- **AES-256-GCM** authenticated encryption
- **PIN never transmitted**: Only a hash hint is visible to relays
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

## Transport Layer

The application uses a protocol-agnostic encryption layer with pluggable signaling:

### Unified Transfer Layer

All three signaling methods (Nostr, PeerJS, QR) share a **common encryption middleware** that operates independently of the transport protocol:

1. **Protocol-Agnostic Encryption**: Content is encrypted in 128KB chunks using AES-256-GCM before transmission. This encryption happens regardless of whether the underlying transport (WebRTC DTLS) already provides encryption - defense in depth.

2. **Chunk Format**: Each encrypted chunk contains:
   ```
   [4 bytes: chunk index][12 bytes: nonce][ciphertext][16 bytes: auth tag]
   ```

3. **Memory-Efficient Receiving**: Receivers preallocate a single buffer based on total expected size and write decrypted chunks directly to their calculated positions (`chunkIndex * 128KB`). No intermediate chunk arrays are created - chunks are decrypted and placed directly into the final buffer.

### Signaling Methods

Signaling is decoupled from the transfer layer. The sender chooses the signaling method:

- **Nostr** (default): PIN exchange and WebRTC signaling via decentralized Nostr relays. Falls back to encrypted cloud transfer if P2P fails.
- **PeerJS**: Uses PeerJS cloud server (0.peerjs.com) for simpler signaling. No cloud fallback - P2P only.
- **QR Code**: Exchange WebRTC signaling data via QR codes. Works without internet - no signaling server required. Devices must be on the same local network for WebRTC to connect via local IP addresses when offline. Both parties must exchange QR codes (scan) or copy/paste the encrypted signaling data. P2P only, no fallback.

### Data Transfer

- **WebRTC P2P** (default): Direct peer-to-peer connection for fastest transfer
- **Cloud Fallback**: If WebRTC fails (Nostr mode only), encrypted data is uploaded to cloud storage with automatic failover

### Why Encrypt Over DTLS?

WebRTC provides DTLS encryption at the transport layer, but we add AES-256-GCM encryption for:
- **Defense in depth**: Multiple encryption layers protect against implementation bugs
- **Consistent security model**: Same encryption whether using P2P or cloud fallback
- **Key control**: Encryption key derived from user's PIN, not transport-layer keys

### PIN Auto-Detection

The signaling method is encoded in the PIN's first character:
- **Uppercase letter** (A-Z): Nostr signaling
- **Lowercase letter** (a-z): PeerJS signaling
- **Digit "2"**: QR code signaling

Receivers don't need to select a signaling method - it's automatically detected from the PIN.

### Cloud Storage Redundancy

Upload servers and CORS proxies with automatic failover:

**Upload Servers:**
- tmpfiles.org
- litterbox.catbox.moe (1h expiration, upload via CORS proxy)

**CORS Proxies (for download):**
- Direct download (for litterbox URLs)
- corsproxy.io
- cors.leverson83.org

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
