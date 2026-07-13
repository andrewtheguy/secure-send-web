# Roadmap

## Planned Features

### NIP-65/NIP-66 Relay Discovery
Implement automatic relay discovery using Nostr relay list events:
- Query seed relays for relay list events (kind 10002 NIP-65, kind 30166 NIP-66)
- Probe discovered relays for latency and capabilities
- Cache discovered relays in sessionStorage with TTL
- Select best relays based on latency, availability, and suitability
- Filter out relays requiring payment or authentication

### Custom Relay Configuration
Allow users to specify their own preferred Nostr relays for signaling.

### Streamed Archive Creation for Multi-File/Folder Sends
Single-file transfers now stream on both ends: the sender encrypts 128KB `Blob.slice` reads on demand, and the receiver writes decrypted chunks to an OPFS scratch file (in-memory buffer fallback), so neither side materializes the file and the cap is 2GB (`MAX_MESSAGE_SIZE`). Multi-file and folder sends remain memory-bound because the ZIP archive is built fully in memory with fflate `zipSync`, capping their combined input at 100MB (`MAX_ARCHIVE_SIZE`).
- Replace `zipSync` with a streaming ZIP writer (e.g. fflate's streaming API) targeting an OPFS scratch file
- Send the resulting disk-backed archive through the existing streaming pipeline
- Lift the multi-file/folder cap to match `MAX_MESSAGE_SIZE`

**Integrity invariant (preserve):** The transfer has **no whole-file checksum** — content integrity comes entirely from per-chunk AES-256-GCM authentication (each chunk carries a 16-byte auth tag with its index bound in as authenticated data), plus chunk-count/byte-count completeness checks and the final data-channel `ACK`. Any streaming rework should preserve that protocol unless a separate whole-file digest gains a concrete requirement. Such a digest could be computed incrementally without materializing the whole file, but it would add protocol state and duplicate integrity work already performed by the authenticated chunks and completeness checks.

### Argon2id Key Derivation
Replace PBKDF2 with Argon2id (via WASM) for stronger resistance to brute-force attacks on the PIN.

## Backlog (Future Considerations)
- Better website UI/UX
