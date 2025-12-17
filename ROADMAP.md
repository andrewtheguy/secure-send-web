# Roadmap

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

### Improved Error Handling
Better user feedback for network errors, relay failures, and WebRTC connection issues.
