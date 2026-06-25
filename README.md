# Secure Send

A web application for sending encrypted files and folders with PIN-based Nostr signaling. Uses WebRTC for direct P2P connections.

**Demo:** [https://securesend.kuvi.app/](https://securesend.kuvi.app/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **Works offline**: No internet required after page load when using Manual Exchange on same local network
- **Flexible signaling**: Nostr (default) or Manual Exchange (QR/copy-paste). Manual Exchange works across networks with internet, or on same local network without internet.
- **PIN-based security (Nostr)**: Nostr signaling payloads are encrypted with the PIN
- **File or folder transfer**: Send files or folders up to 100MB
- **End-to-end encryption**: All transfers use AES-256-GCM encryption
- **No accounts required**: Ephemeral keypairs generated per transfer
- **PWA Support**: Install as a Progressive Web App for offline access

## Version Compatibility

During `v0.0.x` (as shown in the app footer), compatibility between different app versions is not guaranteed.
Sender and receiver should use the same app version for transfers.

## How It Works

### Sending Files or Folders

1. Select the "File" or "Folder" tab
2. Drag and drop a file/folder or click to select (max 100MB total)
3. Click "Generate PIN & Send"
4. Share the generated 12-character PIN (or 7-word equivalent) with the receiver
5. Wait for the receiver to connect and receive the file

### Receiving

1. For Auto Exchange mode, enter the PIN or 7-word sequence shared by the sender. For Manual Exchange mode, scan or paste the sender's signaling payload.
2. Click "Receive"
3. Click "Download File" to save

## Security

- **PBKDF2-SHA256** with 600,000 iterations for key derivation (browser-compatible)
- **AES-256-GCM** authenticated encryption
- **Labeled PIN keys (Nostr)**: One transfer salt derives separate non-extractable AES-GCM keys for `metadata`, `signals`, and `p2p-content`
- **Encrypted metadata (Nostr)**: File metadata in the PIN exchange payload, including name, size, and MIME type, is encrypted with the PIN-derived `metadata` key
- **PIN never transmitted (Nostr)**: Only a one-way PBKDF2 hint is published to relays — a time-bucketed (hourly-rotating) lookup tag used to locate the PIN exchange event, never reversible to the PIN or usable to decrypt data. A separate, time-independent one-way derivation (the "PIN fingerprint") is computed locally on both ends and never published — it's only shown for humans to confirm both sides derived the same PIN
- **Authenticated relay ACKs (Nostr)**: ACK event bodies are encrypted with the PIN-derived `signals` key, so a public transfer ID alone cannot make the sender start, continue, or complete a transfer
- **Ephemeral identities**: New Nostr keypairs generated per transfer
- **1-hour expiration**: Clients enforce a 1-hour transfer TTL; Nostr events include an expiration tag for relays that honor it
- **Manual exchange signaling**: QR payloads are time-bucketed obfuscated, not cryptographically confidential; file data is encrypted with an ECDH-derived AES key after the QR/clipboard exchange

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

Multi-QR URLs are generated from `window.location.origin` and then append `/r#...`.

- Supported: deployment at the domain root (for example `https://example.com`)
- Not supported: deployment under a subpath (for example `https://example.com/my-app`)

If the app is served from a subpath, scanned Multi-QR links will point to the domain root route and can 404.

## Transport Layer

All signaling methods share a **unified encryption layer**: P2P transfers encrypt content in 128KB AES-256-GCM chunks before transmission, with the chunk index authenticated as AES-GCM additional data.

**Signaling Methods** (sender chooses):
- **Nostr** (default): Requires internet. Decentralized relay signaling. Devices can be on different networks.
- **Manual Exchange**: No internet required. Exchange signaling via QR scan or copy/paste (camera optional). With internet, works across different networks. Without internet, devices must be on same local network.

**Data Transfer**: WebRTC P2P only. If a direct P2P connection cannot be established, the transfer does not complete — there is no automatic in-app fallback. When this happens, the UI suggests transferring offline via animated QR codes with [Secure QR Transfer](https://qrsecure.kuvi.app/transfer), a separate tool for side-by-side devices.

See [Architecture](./docs/ARCHITECTURE.md) for detailed transfer flows and encryption specifics.

### Receive Modes

Receivers choose the matching receive mode:
- **Auto Exchange mode**: Nostr signaling with a sender-provided PIN or 7-word equivalent.
- **Manual Exchange mode**: Direct signaling exchange via QR scan or copy/paste (no relay).

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Technical architecture and design decisions
- [Roadmap](./docs/ROADMAP.md) - Completed and planned features

## License

MIT
