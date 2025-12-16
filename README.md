# Secure Send

A web application for sending encrypted text messages using PIN-based encryption over Nostr relays.

## Features

- **PIN-based encryption**: Messages are encrypted with AES-256-GCM using a key derived from an 8-character PIN
- **Nostr relay transport**: Messages are transmitted through public Nostr relays
- **End-to-end encryption**: Relays only see encrypted data and a PIN hint (first 8 hex chars of SHA256)
- **No accounts required**: Ephemeral keypairs are generated for each transfer
- **Large message support**: Send text messages up to 512KB with automatic chunking

## How It Works

### Sending

1. Enter your text message (up to 512KB)
2. Click "Generate PIN & Send"
3. Share the generated 8-character PIN with the receiver through another channel (voice, chat, etc.)
4. Wait for the receiver to connect and receive the message

### Receiving

1. Enter the PIN shared by the sender
2. Click "Receive Message"
3. Wait for the message to be decrypted and displayed

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

- **File transfer support**: Drag-and-drop file sharing (similar to wormhole-rs)
- **Argon2id support**: When browser WASM support improves
- **Custom relay configuration**: Allow users to specify their own relays
- **Multi-recipient support**: Send to multiple receivers with different PINs

## Credits

Inspired by [wormhole-rs](https://github.com/nicobatty/wormhole-rs), a Rust implementation of secure file transfer over Nostr.

## License

MIT
