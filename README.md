# Secure Send

A web application for sending encrypted text messages and files using PIN-based encryption. Uses WebRTC for direct P2P connections with automatic fallback to Nostr relays.

**Demo:** [https://secure-send-web.andrewtheguy.com/](https://secure-send-web.andrewtheguy.com/)

## Features

- **PIN-based encryption**: Content is encrypted with AES-256-GCM using a key derived from a 12-character PIN
- **Text & file transfer**: Send text messages or files up to 10MB
- **WebRTC P2P**: Direct peer-to-peer connections for fast, efficient data transfer
- **Automatic fallback**: Falls back to Nostr relays if WebRTC connection fails
- **Relay-only mode**: Optional "Use Nostr Relay Only" checkbox to disable WebRTC
- **End-to-end encryption**: All data is encrypted end-to-end, relays only see encrypted data and a PIN hint
- **No accounts required**: Ephemeral keypairs are generated for each transfer
- **Chunked transfer**: Large content is split into chunks with ACK-based reliability (relay mode)

## How It Works

### Sending a Text Message

1. Select the "Text Message" tab
2. Enter your message (up to 10MB)
3. (Optional) Check "Use Nostr Relay Only" to disable WebRTC and force relay mode
4. Click "Generate PIN & Send"
5. Share the generated 12-character PIN with the receiver through another channel (voice, chat, etc.)
6. Wait for the receiver to connect and receive the message (via WebRTC P2P or relay fallback)

### Sending a File

1. Select the "File" tab
2. Drag and drop a file or click to select (max 10MB)
3. (Optional) Check "Use Nostr Relay Only" to disable WebRTC and force relay mode
4. Click "Generate PIN & Send"
5. Share the generated 12-character PIN with the receiver
6. Wait for the receiver to connect and receive the file (via WebRTC P2P or relay fallback)

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

1. **PIN Exchange**: Always uses Nostr relays for discoverability - sender publishes encrypted payload with PIN hint
2. **Data Transfer** (unless "Use Nostr Relay Only" is checked):
   - **Default**: Attempts WebRTC P2P connection via data channel for direct transfer
   - **Automatic Fallback**: Falls back to Nostr relays if WebRTC connection fails (timeout after 10 seconds)
   - **Relay-Only Mode**: Bypasses WebRTC entirely when checkbox is enabled
3. **Relay Mode**: Chunked transfer (16KB chunks) with ACK-based reliability, retries, and backup relay discovery

## Future Improvements

- **Add Argon2id key derivation**: Replace PBKDF2 with Argon2id (via WASM) for stronger resistance to brute-force attacks
- **Improved relay reliability**: Better relay selection, health monitoring, and failover strategies
- **Custom relay configuration**: Allow users to specify their own relays

## License

MIT
