# Architecture

## Overview

Secure Send is a browser-based encrypted file and message transfer application. It uses PIN-based encryption, supports two signaling methods (Nostr relays or PeerJS), and enables direct P2P (WebRTC) data transfer with optional cloud fallback (Nostr mode only).

## Core Principles

1. **P2P First**: Direct WebRTC connections are always preferred for data transfer.
2. **End-to-End Encryption**: All data is encrypted client-side before any transmission.
3. **Explicit Signaling Choice**: Users choose between Nostr (with cloud fallback) or PeerJS (P2P only).
4. **PIN-Based Security**: A 12-character PIN serves as the shared secret for key derivation.

## Signaling Methods

By default, Nostr is used for signaling. PeerJS is available as an alternative under "Advanced Options" in the UI. Both sender and receiver must use the same method.

| Feature | Nostr (Default) | PeerJS (Advanced) |
|---------|-----------------|-------------------|
| Signaling Server | Decentralized relays | Centralized (0.peerjs.com) |
| Cloud Fallback | Yes (tmpfiles.org) | No |
| Reliability | Higher (fallback available) | P2P only |
| Privacy | Better (no central server) | PeerJS server sees peer IDs |
| Complexity | More complex | Simpler |
| Recommended For | Unreliable networks, NAT issues | Simple P2P, good connectivity |

## Transfer Flow

### Nostr Mode - P2P Success Path (Preferred)
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

### Cloud Fallback Path (Nostr Mode - When P2P Connection Fails)
```
Sender                              Receiver
  │                                    │
  ├─── PIN Exchange (via Nostr) ──────>│
  │<────────── Ready ACK (seq=0) ──────┤
  │                                    │
  │~~~ P2P connection timeout (15s) ~~~│
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

### PeerJS Mode (P2P Only - No Cloud Fallback)
```
Sender                              Receiver
  │                                    │
  ├─── Create Peer(ss-{pinHint})       │
  │    on 0.peerjs.com:443             │
  │                                    │
  │         (shares PIN out-of-band)   │
  │                                    │
  │                   Connect to ──────┤
  │                   Peer(ss-{pinHint})
  │                                    │
  │<════ PeerJS Data Channel Open ════>│
  │                                    │
  ├─── Metadata (salt, contentType) ──>│
  │<────────── Ready ─────────────────┤
  │                                    │
  │==== Data Transfer (16KB chunks) ===│
  │                                    │
  ├─── Done ──────────────────────────>│
  │<────────── Done ACK ──────────────┤
  ✓                                    ✓

If P2P connection fails → Transfer fails (no cloud fallback)
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

### PeerJS Signaling (`src/lib/peerjs-signaling.ts`)

Alternative signaling method using PeerJS cloud server instead of Nostr relays.

**How it works:**
- Peer ID derived from PIN: `ss-{SHA256(PIN).slice(0, PIN_HINT_LENGTH)}`
- Both sender and receiver compute same peer ID from PIN
- Sender creates peer, receiver connects to that peer ID
- Uses PeerJS cloud server (`0.peerjs.com:443`) for NAT traversal
- Data channel established directly via PeerJS (wraps WebRTC)

**Message Types:**
| Type | Direction | Purpose |
|------|-----------|---------|
| `metadata` | Sender → Receiver | Transfer info (salt, contentType, fileName, etc.) |
| `ready` | Receiver → Sender | Acknowledge metadata received |
| `chunk` | Sender → Receiver | Data chunk (ArrayBuffer) |
| `done` | Sender → Receiver | Transfer complete |
| `done_ack` | Receiver → Sender | Acknowledge completion |

**Key Differences from Nostr:**
- No cloud fallback - P2P only
- Simpler protocol - no event kinds or tags
- Centralized signaling server (PeerJS cloud)
- Metadata exchange happens over data channel (not signaling)

### WebRTC (`src/lib/webrtc.ts`)

Handles direct peer-to-peer connections using WebRTC data channels.

**Features:**
- ICE candidate queuing for reliable connection establishment
- STUN server for NAT traversal (`stun.l.google.com:19302`)
- 16KB chunked data transfer over data channel
- Backpressure support (waits for buffer to drain before sending more data)
- Connection state monitoring

### Cloud Storage (`src/lib/cloud-storage.ts`)

Fallback storage when P2P connection cannot be established (15s timeout). Not used if P2P connects successfully.

**Features:**
- Multiple upload servers with automatic failover
- Multiple CORS proxies for download redundancy
- Service health caching
- Chunked upload/download for files >10MB

**Current Services:**
- Upload: tmpfiles.org
- CORS Proxies: corsproxy.io, leverson83, codetabs, cors-anywhere

### React Hooks (`src/hooks/`)

**Nostr Mode:**

**`use-nostr-send.ts`** - Sender logic (Nostr):
1. Read and encrypt content
2. Publish PIN exchange (without cloud URL)
3. Wait for receiver ready ACK
4. Attempt P2P connection (15s timeout for connection only)
5. If P2P connects: transfer via data channel (all-or-nothing, no cloud fallback)
6. If P2P connection fails: chunked cloud upload with ACK coordination
7. Wait for completion ACK

**`use-nostr-receive.ts`** - Receiver logic (Nostr):
1. Validate PIN and find exchange event
2. Send ready ACK
3. Listen for P2P signals OR chunk notifications
4. If P2P: receive via data channel
5. If cloud: download chunks, send ACKs, combine and decrypt
6. Send completion ACK

**PeerJS Mode:**

**`use-peerjs-send.ts`** - Sender logic (PeerJS):
1. Generate PIN, derive peer ID and encryption key
2. Create Peer with derived ID on PeerJS cloud server
3. Wait for receiver connection (5 min timeout)
4. Send metadata (with salt) over data channel
5. Wait for ready acknowledgment
6. Transfer data in 16KB chunks with backpressure
7. Wait for done acknowledgment
8. If connection fails at any point: transfer fails (no cloud fallback)

**`use-peerjs-receive.ts`** - Receiver logic (PeerJS):
1. Validate PIN, derive peer ID and encryption key
2. Connect to sender's peer ID via PeerJS
3. Receive and decrypt metadata
4. Send ready acknowledgment
5. Receive data chunks, accumulate
6. On done: decrypt content, send done acknowledgment
7. If connection fails: transfer fails (no cloud fallback)

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

**Optimization:** File content encryption is deferred until cloud fallback is triggered. If P2P succeeds, encryption is skipped entirely, saving CPU time and memory for large files.

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
| P2P connection | 30 seconds | Time to establish WebRTC connection (offer/answer/ICE/channel open) |
| P2P offer retry | 5 seconds | Interval to retry WebRTC offer if no answer received |
| P2P data transfer | Unlimited | Once connected, data transfer has no timeout |
| Chunk ACK | 60 seconds | Time to download and acknowledge a cloud chunk |
| Overall transfer | 10 minutes | Maximum time for entire transfer (receiver side) |
| PIN expiration | 1 hour | Transfer session validity (NIP-40) |
| Receiver PIN inactivity | 5 minutes | Clears PIN input if no changes made |

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
│   ├── crypto/              # Cryptographic functions
│   │   ├── constants.ts     # Parameters and limits
│   │   ├── pin.ts           # PIN generation/validation
│   │   ├── kdf.ts           # Key derivation
│   │   └── aes-gcm.ts       # Encryption/decryption
│   ├── nostr/               # Nostr protocol (signaling option 1)
│   │   ├── types.ts         # Type definitions
│   │   ├── events.ts        # Event creation/parsing
│   │   ├── client.ts        # Relay client
│   │   └── relays.ts        # Default relays
│   ├── peerjs-signaling.ts  # PeerJS wrapper (signaling option 2)
│   ├── webrtc.ts            # WebRTC connection (Nostr mode)
│   ├── cloud-storage.ts     # Cloud fallback (Nostr mode only)
│   └── file-utils.ts        # File reading utilities
├── hooks/
│   ├── use-nostr-send.ts    # Sender hook (Nostr mode)
│   ├── use-nostr-receive.ts # Receiver hook (Nostr mode)
│   ├── use-peerjs-send.ts   # Sender hook (PeerJS mode)
│   └── use-peerjs-receive.ts # Receiver hook (PeerJS mode)
├── components/              # React UI components
└── pages/                   # Page components
```
