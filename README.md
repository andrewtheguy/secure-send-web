# Secure Send

A web application for sending encrypted text messages and files using PIN-based encryption over Nostr relays.

## Features

- **PIN-based encryption**: Content is encrypted with AES-256-GCM using a key derived from an 8-character PIN
- **Text & file transfer**: Send text messages or files up to 512KB
- **Nostr relay transport**: Content is transmitted through public Nostr relays
- **End-to-end encryption**: Relays only see encrypted data and a PIN hint (first 8 hex chars of SHA256)
- **No accounts required**: Ephemeral keypairs are generated for each transfer
- **Chunked transfer**: Large content is split into 16KB chunks for reliable delivery

## How It Works

### Sending a Text Message

1. Select the "Text Message" tab
2. Enter your message (up to 512KB)
3. Click "Generate PIN & Send"
4. Share the generated 8-character PIN with the receiver through another channel (voice, chat, etc.)
5. Wait for the receiver to connect and receive the message

### Sending a File

1. Select the "File" tab
2. Drag and drop a file or click to select (max 512KB)
3. Click "Generate PIN & Send"
4. Share the generated 8-character PIN with the receiver
5. Wait for the receiver to connect and receive the file

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

## Future Improvements

- **Argon2id support**: When browser WASM support improves
- **Custom relay configuration**: Allow users to specify their own relays
- **Multi-recipient support**: Send to multiple receivers with different PINs
- **Larger file transfers**: Stream-based transfers for files > 512KB

## License

MIT
