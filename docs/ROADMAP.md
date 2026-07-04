# Roadmap

## Planned Features

### Improved Error Handling
Better user feedback for network errors, relay failures, and WebRTC connection issues.

## Backlog (Future Considerations)
- Better website UI/UX

### NIP-65/NIP-66 Relay Discovery
Implement automatic relay discovery using Nostr relay list events:
- Query seed relays for relay list events (kind 10002 NIP-65, kind 30166 NIP-66)
- Probe discovered relays for latency and capabilities
- Cache discovered relays in sessionStorage with TTL
- Select best relays based on latency, availability, and suitability
- Filter out relays requiring payment or authentication

### Custom Relay Configuration
Allow users to specify their own preferred Nostr relays for signaling.

### Lower-Memory Large File Pipeline
The current protocol streams 128KB encrypted chunks over WebRTC and decrypts directly into a preallocated receive buffer, but the app still reads the selected file/archive into memory before sending and keeps the final received file in memory for download.
- Use browser Streams APIs for sender-side file reads instead of materializing the full file first
- Pair the receive path with direct-to-disk writes where supported
- Enable larger transfers without increasing peak memory usage

**Integrity invariant (preserve):** The transfer has **no whole-file checksum** — content integrity comes entirely from per-chunk AES-256-GCM authentication (each chunk carries a 16-byte auth tag with its index bound in as authenticated data), plus chunk-count/byte-count completeness checks and the final data-channel `ACK`. Because integrity is verified per chunk and never over the assembled whole, no design in this pipeline needs to materialize the full file to compute or re-check a digest. A whole-file checksum would have forced full materialization on both sides and been slow in the browser for large files; the streaming rework must keep relying on the self-validating per-chunk model rather than reintroducing one.

### Argon2id Key Derivation
Replace PBKDF2 with Argon2id (via WASM) for stronger resistance to brute-force attacks on the PIN.

### File System Access API for Direct-to-Disk Streaming
Use the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) to write received file chunks directly to disk, eliminating the need to buffer the entire file in memory.

**Benefits:**
- Near-zero memory usage for receiving files (only one chunk in memory at a time)
- Enable transfers of files larger than available RAM
- Decrypted chunks written directly to file handle
- Safe to write-and-drop each chunk immediately: every chunk self-authenticates on decrypt (AES-GCM auth tag + authenticated index), so there is no post-assembly whole-file verification step that would require keeping the full file around

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
