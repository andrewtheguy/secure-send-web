# Secure Send

A web application for sending encrypted text messages and files using PIN-based encryption. Uses WebRTC for direct P2P connections with cloud fallback.

**Demo:** [https://secure-send-web.andrewtheguy.com/](https://secure-send-web.andrewtheguy.com/)

## Features

- **PIN-based encryption**: Content is encrypted with AES-256-GCM using a key derived from a 12-character PIN
- **Text & file transfer**: Send text messages or files up to 100MB
- **WebRTC P2P**: Direct peer-to-peer connections for fast, efficient data transfer
- **Cloud fallback**: Falls back to tmpfiles.org if WebRTC connection fails
- **End-to-end encryption**: All data is encrypted before upload, only you and the receiver can decrypt
- **No accounts required**: Ephemeral keypairs are generated for each transfer
- **Nostr signaling**: Uses Nostr relays for PIN exchange and connection handshake

## How It Works

### Sending a Text Message

1. Select the "Text Message" tab
2. Enter your message (up to 100MB)
3. (Optional) Check "Disable WebRTC" to force cloud transfer only
4. Click "Generate PIN & Send"
5. Share the generated 12-character PIN with the receiver through another channel (voice, chat, etc.)
6. Wait for the receiver to connect and receive the message

### Sending a File

1. Select the "File" tab
2. Drag and drop a file or click to select (max 100MB)
3. (Optional) Check "Disable WebRTC" to force cloud transfer only
4. Click "Generate PIN & Send"
5. Share the generated 12-character PIN with the receiver
6. Wait for the receiver to connect and receive the file

### Receiving

1. Enter the PIN shared by the sender
2. Click "Receive"
3. For text: View and copy the decrypted message
4. For files: Click "Download File" to save

## Security

- **PBKDF2-SHA256** with 600,000 iterations for key derivation (browser-compatible)
- **AES-256-GCM** authenticated encryption
- **PIN never transmitted**: Only a hash hint is visible to relays
- **Ephemeral identities**: New Nostr keypairs generated per transfer
- **1-hour expiration**: PIN exchange events expire automatically

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

The application uses a hybrid transport approach:

1. **Nostr Signaling**: PIN exchange and WebRTC signaling via Nostr relays
2. **Data Transfer**:
   - **WebRTC P2P** (default): Direct peer-to-peer connection for fastest transfer
   - **Cloud Fallback**: If WebRTC fails, encrypted data is uploaded to tmpfiles.org (60 min retention)
3. **Encryption**: All data is encrypted client-side before any transfer

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for planned features.

## License

MIT
