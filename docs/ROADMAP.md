# Roadmap

## Planned Features

### better issued date/expiration date logic for mutual tokens for request and final tokens

### Include expiration date for the final token

### Improved Error Handling
Better user feedback for network errors, relay failures, and WebRTC connection issues.

## Backlog (Future Considerations)
- Better website UI/UX

### Encrypted Mutual Contact Tokens
Encrypt the mutual contact token payload so only the two parties can read it:

**Current state:**
- Token is plaintext JSON with both parties' public IDs, contact keys, and HMAC signatures
- Anyone who intercepts the token can see who the parties are (via fingerprints)

**Proposed improvement:**
- Derive an AES-256-GCM encryption key from both parties' HMAC keys (or a shared HKDF derivation)
- Encrypt the token payload; only parties with their HMAC key can decrypt
- Token becomes opaque to third parties

**Benefits:**
- Privacy: Intercepted tokens reveal nothing about the parties
- Metadata protection: Even party fingerprints are hidden
- Same security model: Still requires out-of-band fingerprint verification

**Implementation approach:**
- During token creation, initiator encrypts with key derived from their HMAC key
- Countersigner decrypts (derives same key from their HMAC key since challenge includes both cpks)
- Or use a simpler scheme: encrypt with random key, include key encrypted to each party's cpk

**Trade-offs:**
- More complex token format
- Both parties must authenticate to read token contents (already required for signing)
- Slightly larger token size due to encryption overhead


### NIP-65/NIP-66 Relay Discovery
Implement automatic relay discovery using Nostr relay list events:
- Query seed relays for relay list events (kind 10002 NIP-65, kind 30166 NIP-66)
- Probe discovered relays for latency and capabilities
- Cache discovered relays in sessionStorage with TTL
- Select best relays based on latency, availability, and suitability
- Filter out relays requiring payment or authentication

### Custom Relay Configuration
Allow users to specify their own preferred Nostr relays for signaling.

### True Streaming for Large Files
Current chunked implementation still loads 10MB chunks into memory.
- Implement true streaming with smaller buffer sizes
- Use Streams API for more efficient memory usage
- Enable even larger file transfers

### Argon2id Key Derivation
Replace PBKDF2 with Argon2id (via WASM) for stronger resistance to brute-force attacks on the PIN.

### File System Access API for Direct-to-Disk Streaming
Use the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) to write received file chunks directly to disk, eliminating the need to buffer the entire file in memory.

**Benefits:**
- Near-zero memory usage for receiving files (only one chunk in memory at a time)
- Enable transfers of files larger than available RAM
- Decrypted chunks written directly to file handle

**Implementation approach:**
- Use `showSaveFilePicker()` to get a writable file handle before transfer starts
- Create a `FileSystemWritableFileStream` for streaming writes
- Write each decrypted chunk directly to disk as it arrives
- Close the stream when transfer completes

**Browser support:**
- Chrome/Edge: Full support (Chromium 86+)
- Safari: Partial support (origin private file system only)
- Firefox: Not supported (use fallback to current in-memory approach)

**Fallback strategy:**
- Feature-detect `window.showSaveFilePicker`
- If unavailable, use current in-memory buffering approach
- Progressive enhancement - works everywhere, better on supported browsers
