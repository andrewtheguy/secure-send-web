# Roadmap

## Completed Features

### 100MB File Support with P2P-First Architecture
- Max file size increased from 10MB to 100MB
- P2P (WebRTC) connections are attempted first - no cloud involvement when successful
- **All-or-nothing P2P**: Once P2P connection is established, transfer completes or fails - no cloud fallback mid-transfer
- Cloud fallback only when P2P connection fails (15s timeout)
- Chunked cloud uploads (10MB per chunk) with ACK coordination
- Sequential chunk upload/download to manage memory usage
- WebRTC backpressure support prevents send queue overflow
- **Deferred encryption**: File encryption is skipped for P2P, only triggered for cloud fallback

## Planned Features

### NIP-65/NIP-66 Relay Discovery
Implement automatic relay discovery using Nostr relay list events:
- Query seed relays for relay list events (kind 10002 NIP-65, kind 30166 NIP-66)
- Probe discovered relays for latency and capabilities
- Cache discovered relays in sessionStorage with TTL
- Select best relays based on latency, availability, and suitability
- Filter out relays requiring payment or authentication

### Argon2id Key Derivation
Replace PBKDF2 with Argon2id (via WASM) for stronger resistance to brute-force attacks on the PIN.

### Custom Relay Configuration
Allow users to specify their own preferred Nostr relays for signaling.

### True Streaming for Large Files
Current chunked implementation still loads 10MB chunks into memory.
- Implement true streaming with smaller buffer sizes
- Use Streams API for more efficient memory usage
- Enable even larger file transfers

### Improved Error Handling
Better user feedback for network errors, relay failures, and WebRTC connection issues.
