# Secure Send

A web application for sending encrypted text messages and files using PIN-based signaling protection and optional cloud encryption. Uses WebRTC for direct P2P connections with cloud fallback.

**Demo:** [https://secure-send-web.andrewtheguy.com/](https://secure-send-web.andrewtheguy.com/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **PIN-based security**: PIN encrypts signaling payloads so only the PIN holder can establish a connection
- **Text & file transfer**: Send text messages or files up to 100MB
- **Word-based PIN representation**: Bijectively map the alphanumeric PIN to 7 words from the BIP-39 wordlist for easier sharing by voice or chat
- **WebRTC P2P**: Direct peer-to-peer connections for fast, efficient data transfer
- **Cloud fallback**: Automatic multi-host upload failover (tmpfiles.org, litterbox.catbox.moe, uguu.se, x0.at) if WebRTC connection fails
- **End-to-end encryption**: All transfers use AES-256-GCM encryption with unique nonces per chunk, in addition to WebRTC DTLS
- **No accounts required**: Ephemeral keypairs are generated for each transfer
- **Multiple signaling methods**: Choose between Nostr relays (with cloud fallback), PeerJS (simpler P2P), or Manual Exchange (works without internet on local network)
- **Auto-detection**: Receiver automatically detects signaling method from PIN format
- **PWA Support**: Install as a Progressive Web App for offline access (QR scanning works offline after install)

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
4. Share the generated 12-character PIN (or word equivalent) with the receiver
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

All signaling methods share a **unified encryption layer**: content is encrypted in 128KB AES-256-GCM chunks before transmission, regardless of transport. Receivers preallocate buffers and write directly to position for memory efficiency.

**Signaling Methods** (sender chooses):
- **Nostr** (default): Requires internet. Decentralized relay signaling. Devices can be on different networks. Has cloud fallback.
- **PeerJS**: Requires internet. Simpler P2P via PeerJS cloud server. Devices can be on different networks. No fallback.
- **Manual Exchange**: No internet required. Exchange signaling via QR scan or copy/paste (camera optional). With internet, works across different networks. Without internet, devices must be on same local network.

**Data Transfer**: WebRTC P2P preferred; cloud fallback available in Nostr mode only.

See [Architecture](./docs/ARCHITECTURE.md) for detailed transfer flows and encryption specifics.

### PIN Auto-Detection

The signaling method is encoded in the PIN's first character:
- **Uppercase letter** (A-Z): Nostr signaling
- **Lowercase letter** (a-z): PeerJS signaling
- **Digit "2"**: Manual exchange (QR or copy/paste)

Receivers don't need to select a signaling method - it's automatically detected from the PIN.

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
