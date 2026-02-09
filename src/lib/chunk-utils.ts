/**
 * Utilities for splitting binary payloads into URL-based QR chunks
 * and reassembling them on the receiver side.
 *
 * Chunk wire format (before base64url):
 *   [1 byte: chunk_index (0-based)] [1 byte: total_chunks] [N bytes: data]
 */

export function base64urlEncode(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function base64urlDecode(encoded: string): Uint8Array {
  // Restore standard base64 characters
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  // Add padding
  while (base64.length % 4 !== 0) {
    base64 += '='
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Split a binary payload into chunks, each prefixed with [index][total].
 * Distributes data evenly across chunks so all QR codes are similar size.
 * Returns an array of Uint8Array chunks ready for base64url encoding.
 */
export function chunkPayload(binary: Uint8Array, maxDataBytes = 400): Uint8Array[] {
  const totalChunks = Math.max(1, Math.ceil(binary.length / maxDataBytes))
  if (totalChunks > 255) {
    throw new Error(`Payload too large: would need ${totalChunks} chunks (max 255)`)
  }

  // Distribute evenly: each chunk gets floor or ceil of (total / chunks)
  const baseSize = Math.floor(binary.length / totalChunks)
  const remainder = binary.length % totalChunks

  const chunks: Uint8Array[] = []
  let offset = 0
  for (let i = 0; i < totalChunks; i++) {
    // First `remainder` chunks get one extra byte
    const sliceLen = baseSize + (i < remainder ? 1 : 0)
    const dataSlice = binary.slice(offset, offset + sliceLen)
    offset += sliceLen

    const chunk = new Uint8Array(2 + dataSlice.length)
    chunk[0] = i          // chunk_index
    chunk[1] = totalChunks // total_chunks
    chunk.set(dataSlice, 2)
    chunks.push(chunk)
  }

  return chunks
}

/**
 * Build a URL for a single chunk.
 * For HashRouter: {baseUrl}/#/r?d={base64url}
 * For BrowserRouter: {baseUrl}/r?d={base64url}
 */
export function buildChunkUrl(baseUrl: string, chunk: Uint8Array, useHash: boolean): string {
  const encoded = base64urlEncode(chunk)
  const base = baseUrl.replace(/\/$/, '')
  if (useHash) {
    return `${base}/#/r?d=${encoded}`
  }
  return `${base}/r?d=${encoded}`
}

/**
 * Parse a base64url-encoded chunk string into its components.
 * Returns null if the chunk is invalid.
 */
export function parseChunk(encoded: string): { index: number; total: number; data: Uint8Array } | null {
  try {
    const bytes = base64urlDecode(encoded)
    if (bytes.length < 3) return null // Need at least index + total + 1 byte data

    const index = bytes[0]
    const total = bytes[1]
    if (total === 0 || index >= total) return null

    const data = bytes.slice(2)
    return { index, total, data }
  } catch {
    return null
  }
}

/**
 * Reassemble chunks into the original binary payload.
 * Returns null if any chunk is missing.
 */
export function reassembleChunks(chunks: Map<number, Uint8Array>, total: number): Uint8Array | null {
  if (chunks.size !== total) return null

  // Verify all indices present
  for (let i = 0; i < total; i++) {
    if (!chunks.has(i)) return null
  }

  // Calculate total size
  let totalSize = 0
  for (let i = 0; i < total; i++) {
    totalSize += chunks.get(i)!.length
  }

  // Assemble
  const result = new Uint8Array(totalSize)
  let offset = 0
  for (let i = 0; i < total; i++) {
    const chunk = chunks.get(i)!
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

/**
 * Extract the `d` query parameter from a URL string.
 * Handles both hash and non-hash URLs.
 */
export function extractChunkParam(url: string): string | null {
  try {
    const parsed = new URL(url)

    // Try regular query params first (BrowserRouter: /r?d=...)
    const fromQuery = parsed.searchParams.get('d')
    if (fromQuery) return fromQuery

    // Try hash-based query params (HashRouter: /#/r?d=...)
    const hash = parsed.hash
    if (hash) {
      const qIdx = hash.indexOf('?')
      if (qIdx !== -1) {
        const hashParams = new URLSearchParams(hash.slice(qIdx + 1))
        return hashParams.get('d')
      }
    }

    return null
  } catch {
    return null
  }
}
