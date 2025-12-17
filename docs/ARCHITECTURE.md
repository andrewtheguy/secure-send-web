# Architecture

## Overview

Secure Send is a browser-based encrypted file and message transfer application. It uses PIN-based encryption, Nostr relays for signaling, and supports both direct P2P (WebRTC) and cloud storage fallback for data transfer.

## Core Principles

1. **P2P First**: Direct WebRTC connections are preferred. Cloud storage is only used when P2P fails.
2. **End-to-End Encryption**: All data is encrypted client-side before any transmission.
3. **No Server Dependencies**: Uses decentralized Nostr relays for signaling and public cloud storage for fallback.
4. **PIN-Based Security**: A 12-character PIN serves as the shared secret for key derivation.

## Transfer Flow

### P2P Success Path (Preferred)
```
Sender                              Receiver
  │                                    │
  ├─── PIN Exchange (via Nostr) ──────>│
  │<────────── Ready ACK (seq=0) ──────┤
  │                                    │
  ├─── WebRTC Offer ──────────────────>│
  │<────────── WebRTC Answer ──────────┤
  │                                    │
  │==== P2P Data Channel (16KB chunks) ===│
  │                                    │
  │<────────── Complete ACK (seq=-1) ──┤
  ✓                                    ✓
```

### Cloud Fallback Path (When P2P Fails)
```
Sender                              Receiver
  │                                    │
  ├─── PIN Exchange (via Nostr) ──────>│
  │<────────── Ready ACK (seq=0) ──────┤
  │                                    │
  │~~~ P2P attempt fails (timeout) ~~~~│
  │                                    │
  ├─── Upload Chunk 0 to cloud         │
  ├─── ChunkNotify (chunk 0 URL) ─────>│
  │                                    ├─── Download chunk 0
  │<────────── Chunk ACK (seq=1) ──────┤
  │                                    │
  ├─── Upload Chunk N to cloud         │
  ├─── ChunkNotify (chunk N URL) ─────>│
  │                                    ├─── Download chunk N
  │<────────── Chunk ACK (seq=N+1) ────┤
  │                                    │
  │                                    ├─── Combine & decrypt
  │<────────── Complete ACK (seq=-1) ──┤
  ✓                                    ✓
```

## Key Components

### Cryptography (`src/lib/crypto/`)

| Component | Description |
|-----------|-------------|
| `pin.ts` | PIN generation and validation (12-char, mixed charset) |
| `kdf.ts` | Key derivation using PBKDF2-SHA256 (600,000 iterations) |
| `aes-gcm.ts` | AES-256-GCM encryption/decryption |
| `constants.ts` | Crypto parameters, size limits, timeouts |

**Key Parameters:**
- `MAX_MESSAGE_SIZE`: 100MB (maximum file size)
- `CLOUD_CHUNK_SIZE`: 10MB (chunk size for cloud uploads)
- `CHUNK_SIZE`: 16KB (WebRTC data channel chunk size)
- `PBKDF2_ITERATIONS`: 600,000

### Nostr Signaling (`src/lib/nostr/`)

Uses Nostr protocol for decentralized signaling between sender and receiver.

**Event Kinds:**
| Kind | Purpose |
|------|---------|
| 24243 | PIN Exchange - Contains encrypted transfer metadata |
| 24242 | Data Transfer - ACKs, WebRTC signals, chunk notifications |

**Event Types (via tags):**
- `pin_exchange`: Initial transfer setup
- `ack`: Acknowledgments (seq=0 ready, seq=N chunk, seq=-1 complete)
- `signal`: WebRTC signaling (offer/answer/candidates)
- `chunk_notify`: Cloud chunk URL notification

**Files:**
- `types.ts`: Type definitions for payloads and events
- `events.ts`: Event creation and parsing functions
- `client.ts`: Nostr relay connection management
- `relays.ts`: Default relay configuration
- `discovery.ts`: Backup relay discovery

### WebRTC (`src/lib/webrtc.ts`)

Handles direct peer-to-peer connections using WebRTC data channels.

**Features:**
- ICE candidate queuing for reliable connection establishment
- STUN server for NAT traversal (`stun.l.google.com:19302`)
- 16KB chunked data transfer over data channel
- Connection state monitoring

### Cloud Storage (`src/lib/cloud-storage.ts`)

Fallback storage when P2P is unavailable. Only used if WebRTC fails.

**Features:**
- Multiple upload servers with automatic failover
- Multiple CORS proxies for download redundancy
- Service health caching
- Chunked upload/download for files >10MB

**Current Services:**
- Upload: tmpfiles.org
- CORS Proxies: corsproxy.io, leverson83, codetabs, cors-anywhere

### React Hooks (`src/hooks/`)

**`use-nostr-send.ts`** - Sender logic:
1. Read and encrypt content
2. Publish PIN exchange (without cloud URL)
3. Wait for receiver ready ACK
4. Attempt P2P transfer (15s timeout)
5. If P2P fails: chunked cloud upload with ACK coordination
6. Wait for completion ACK

**`use-nostr-receive.ts`** - Receiver logic:
1. Validate PIN and find exchange event
2. Send ready ACK
3. Listen for P2P signals OR chunk notifications
4. If P2P: receive via data channel
5. If cloud: download chunks, send ACKs, combine and decrypt
6. Send completion ACK

## Data Encryption

### PIN Exchange Payload
```typescript
interface PinExchangePayload {
  contentType: 'text' | 'file'
  transferId: string
  senderPubkey: string
  totalChunks: number
  relays?: string[]
  // File metadata (if file)
  fileName?: string
  fileSize?: number
  mimeType?: string
}
```

### Encryption Flow
1. **PIN Generation**: 12-character from mixed charset (excluding ambiguous chars)
2. **Salt Generation**: 16 random bytes
3. **Key Derivation**: PBKDF2-SHA256 with 600,000 iterations
4. **Encryption**: AES-256-GCM with 12-byte nonce

### What's Encrypted Where

| Data | P2P Transfer | Cloud Transfer |
|------|--------------|----------------|
| PIN Exchange Payload | Encrypted (AES-GCM) | Encrypted (AES-GCM) |
| WebRTC Signals | Encrypted (AES-GCM) | N/A |
| File Content | Raw (channel is secure) | Encrypted (AES-GCM) |

**Note:** P2P sends raw content because the WebRTC data channel is already a secure, authenticated channel between the two peers. Cloud storage receives encrypted data because it's stored on third-party servers.

## Size Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max file size | 100MB | Memory constraints, cloud service limits |
| Cloud chunk size | 10MB | Per-upload limit, memory efficiency |
| WebRTC chunk size | 16KB | Data channel buffer management |
| PIN length | 12 chars | Balance of usability and security |

## Timeout Configuration

| Timeout | Duration | Purpose |
|---------|----------|---------|
| P2P setup | 15 seconds | Time to establish WebRTC connection |
| Chunk ACK | 60 seconds | Time to download and acknowledge a chunk |
| Overall transfer | 10 minutes | Maximum time for entire transfer |
| PIN expiration | 1 hour | Transfer session validity (NIP-40) |

## Security Considerations

1. **Ephemeral Keys**: New keypair generated for each transfer
2. **Forward Secrecy**: PIN-derived key is unique per transfer (includes random salt)
3. **No Server Trust**: Encrypted data on cloud, relays only see metadata
4. **PIN Entropy**: ~71 bits with 12-char mixed charset
5. **Brute-Force Resistance**: 600K PBKDF2 iterations (planned: Argon2id)

## File Structure

```
src/
├── lib/
│   ├── crypto/          # Cryptographic functions
│   │   ├── constants.ts # Parameters and limits
│   │   ├── pin.ts       # PIN generation/validation
│   │   ├── kdf.ts       # Key derivation
│   │   └── aes-gcm.ts   # Encryption/decryption
│   ├── nostr/           # Nostr protocol
│   │   ├── types.ts     # Type definitions
│   │   ├── events.ts    # Event creation/parsing
│   │   ├── client.ts    # Relay client
│   │   └── relays.ts    # Default relays
│   ├── webrtc.ts        # WebRTC connection
│   ├── cloud-storage.ts # Cloud fallback
│   └── file-utils.ts    # File reading utilities
├── hooks/
│   ├── use-nostr-send.ts    # Sender hook
│   └── use-nostr-receive.ts # Receiver hook
├── components/          # React UI components
└── pages/               # Page components
```
