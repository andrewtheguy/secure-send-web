import pako from 'pako'
import { base45Encode, base45Decode } from './base45'
import type { ContentType } from './nostr/types'

/**
 * QR Signaling Format Version
 *
 * IMPORTANT: If you change the minified format in a backwards-incompatible way,
 * you must use a new PIN first character (e.g., "3" instead of "2") to ensure
 * old clients don't try to parse new format data.
 *
 * Current version uses PIN prefix "2" (defined in crypto/constants.ts)
 *
 * Version history:
 * - v1: Initial format with basic minification
 * - v2: Compact binary encoding for IPs, fingerprint, and large numbers
 */
const QR_FORMAT_VERSION = 2

/**
 * QR Signaling Payload - exchanged via QR codes between sender and receiver
 */
export interface QRSignalingPayload {
  type: 'offer' | 'answer'
  sdp: string
  candidates: string[] // ICE candidates as SDP strings
  // Offer-only fields:
  salt?: number[] // Encryption salt for key derivation
  contentType?: ContentType
  fileName?: string
  fileSize?: number
  mimeType?: string
  totalBytes?: number
}

/**
 * Minified internal payload format for QR compression
 * Uses short keys to reduce JSON size before gzip
 */
interface MinifiedPayload {
  v: number      // version
  t: 'o' | 'a'   // type: offer/answer
  s: string      // sdp
  c: string[]    // candidates (minified)
  // Offer-only fields:
  x?: string     // salt as hex string (was number[], now compact)
  ct?: 'f' | 't' // contentType: file/text (was full string)
  fn?: string    // fileName
  fs?: number    // fileSize
  mt?: string    // mimeType
  tb?: number    // totalBytes
}

/**
 * Minify ICE candidate string with binary encoding (v2 format)
 *
 * Input:  "candidate:738418781 1 udp 2122063615 10.22.34.100 59067 typ host generation 0 ufrag cZ5M network-id 1"
 * Output: "~F|P|proto|PR|IP|port|typ|..." where F=foundation(b64), P=priority(b64), IP=ip(b64), port=port(b64)
 *
 * Format: ~foundation|component|proto|priority|ip|port|type[|raddr|rport][|tcptype]
 * - ~ prefix indicates v2 compact format
 * - foundation, priority encoded as base64 uint32
 * - port encoded as base64 uint16
 * - IP encoded as 4+base64 (IPv4) or 6+base64 (IPv6)
 */
function minifyCandidate(candidate: string): string {
  // Remove redundant fields first
  const stripped = candidate
    .replace(/ generation \d+/g, '')
    .replace(/ ufrag \S+/g, '')
    .replace(/ network-id \d+/g, '')
    .replace(/ network-cost \d+/g, '')
    .trim()

  // Parse candidate string
  // Format: candidate:foundation component protocol priority ip port typ type [raddr addr] [rport port] [tcptype type]
  const match = stripped.match(
    /^candidate:(\d+) (\d+) (udp|tcp) (\d+) ([^\s]+) (\d+) typ (\w+)(?: raddr ([^\s]+))?(?: rport (\d+))?(?: tcptype (\w+))?$/i
  )

  if (!match) {
    // Can't parse, return as-is (without redundant fields)
    return stripped
  }

  const [, foundation, component, proto, priority, ip, port, type, raddr, rport, tcptype] = match

  // Skip minification for mDNS .local addresses (can't be IP-encoded)
  if (ip.endsWith('.local') || (raddr && raddr.endsWith('.local'))) {
    return stripped
  }

  // Skip if IP is not a valid IPv4/IPv6 (e.g., 0.0.0.0 or ::)
  if (ip === '0.0.0.0' || ip === '::') {
    return stripped
  }

  // Build compact form with ~ prefix
  const parts = [
    encodeUint32(parseInt(foundation, 10)),  // foundation → base64
    component,                                 // always 1, keep as-is
    proto[0],                                  // udp→u, tcp→t
    encodeUint32(parseInt(priority, 10)),    // priority → base64
    encodeIP(ip),                              // IP → 4+b64 or 6+b64
    encodeUint16(parseInt(port, 10)),        // port → base64
    type[0],                                   // host→h, srflx→s, prflx→p, relay→r
  ]

  // Add optional fields
  if (raddr && raddr !== '0.0.0.0' && raddr !== '::') {
    parts.push(encodeIP(raddr))
    parts.push(encodeUint16(parseInt(rport || '0', 10)))
  }
  if (tcptype) {
    parts.push(tcptype[0]) // active→a, passive→p, so→s
  }

  return '~' + parts.join('|')
}

/**
 * Expand minified candidate back to full format
 * Handles both compact (~prefixed) and plain formats
 */
function expandCandidate(minified: string): string {
  // If not compact format, just add generation 0 if needed
  if (!minified.startsWith('~')) {
    if (!minified.includes(' generation ')) {
      return minified + ' generation 0'
    }
    return minified
  }

  // Parse compact format
  const parts = minified.slice(1).split('|') // Remove ~ prefix
  const foundation = decodeUint32(parts[0])
  const component = parts[1]
  const proto = parts[2] === 'u' ? 'udp' : 'tcp'
  const priority = decodeUint32(parts[3])
  const ip = decodeIP(parts[4])
  const port = decodeUint16(parts[5])
  const typeChar = parts[6]
  const typeMap: Record<string, string> = { h: 'host', s: 'srflx', p: 'prflx', r: 'relay' }
  const type = typeMap[typeChar] || typeChar

  let result = `candidate:${foundation} ${component} ${proto} ${priority} ${ip} ${port} typ ${type}`

  // Check for raddr/rport (parts 7 and 8)
  if (parts[7] && parts[7].match(/^[46]/)) {
    const raddr = decodeIP(parts[7])
    const rport = decodeUint16(parts[8])
    result += ` raddr ${raddr} rport ${rport}`
    // tcptype would be at index 9
    if (parts[9]) {
      const tcptypeMap: Record<string, string> = { a: 'active', p: 'passive', s: 'so' }
      result += ` tcptype ${tcptypeMap[parts[9]] || parts[9]}`
    }
  } else if (parts[7]) {
    // No raddr, parts[7] is tcptype
    const tcptypeMap: Record<string, string> = { a: 'active', p: 'passive', s: 'so' }
    result += ` tcptype ${tcptypeMap[parts[7]] || parts[7]}`
  }

  result += ' generation 0'
  return result
}

/**
 * Convert byte array to base64 string (more compact than hex)
 * 16 bytes → 24 chars (base64) vs 32 chars (hex)
 */
function bytesToBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Convert base64 string back to byte array
 */
function base64ToBytes(b64: string): number[] {
  const binary = atob(b64)
  const bytes: number[] = []
  for (let i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i))
  }
  return bytes
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convert base64 string to Uint8Array
 */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ============================================================================
// IP Address and Number Encoding (v2 format)
// ============================================================================

/**
 * Encode IPv4 address to base64 (12 chars → 6 chars)
 * e.g., "10.22.34.100" → "ChYiZA=="
 */
function encodeIPv4(ip: string): string {
  const parts = ip.split('.').map(Number)
  return btoa(String.fromCharCode(...parts))
}

/**
 * Decode base64 back to IPv4 address
 */
function decodeIPv4(b64: string): string {
  const bytes = atob(b64)
  return Array.from(bytes).map(c => c.charCodeAt(0)).join('.')
}

/**
 * Encode IPv6 address to base64 (~39 chars → 22 chars)
 * e.g., "fdb8:d92a:f690:3d7f:85d:c65c:f82b:d902" → base64
 */
function encodeIPv6(ip: string): string {
  // Expand :: shorthand if present
  const expanded = expandIPv6(ip)
  const parts = expanded.split(':')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const val = parseInt(parts[i], 16)
    bytes[i * 2] = (val >> 8) & 0xff
    bytes[i * 2 + 1] = val & 0xff
  }
  return uint8ArrayToBase64(bytes)
}

/**
 * Expand IPv6 :: shorthand to full form
 */
function expandIPv6(ip: string): string {
  if (!ip.includes('::')) return ip
  const [left, right] = ip.split('::')
  const leftParts = left ? left.split(':') : []
  const rightParts = right ? right.split(':') : []
  const missing = 8 - leftParts.length - rightParts.length
  const middle = Array(missing).fill('0')
  return [...leftParts, ...middle, ...rightParts].join(':')
}

/**
 * Decode base64 back to IPv6 address
 */
function decodeIPv6(b64: string): string {
  const bytes = base64ToUint8Array(b64)
  const parts: string[] = []
  for (let i = 0; i < 16; i += 2) {
    const val = (bytes[i] << 8) | bytes[i + 1]
    parts.push(val.toString(16))
  }
  return parts.join(':')
}

/**
 * Detect if string is IPv6 address
 */
function isIPv6(ip: string): boolean {
  return ip.includes(':')
}

/**
 * Encode any IP address to base64
 * Returns format: "4:base64" for IPv4, "6:base64" for IPv6
 */
function encodeIP(ip: string): string {
  if (isIPv6(ip)) {
    return '6' + encodeIPv6(ip)
  }
  return '4' + encodeIPv4(ip)
}

/**
 * Decode IP from prefixed base64 format
 */
function decodeIP(encoded: string): string {
  const type = encoded[0]
  const b64 = encoded.slice(1)
  if (type === '6') {
    return decodeIPv6(b64)
  }
  return decodeIPv4(b64)
}

/**
 * Encode 32-bit unsigned integer to base64 (10 chars → 6 chars)
 * e.g., "2129605509" → base64
 */
function encodeUint32(num: number): string {
  const bytes = new Uint8Array(4)
  bytes[0] = (num >> 24) & 0xff
  bytes[1] = (num >> 16) & 0xff
  bytes[2] = (num >> 8) & 0xff
  bytes[3] = num & 0xff
  return uint8ArrayToBase64(bytes)
}

/**
 * Decode base64 back to 32-bit unsigned integer
 */
function decodeUint32(b64: string): number {
  const bytes = base64ToUint8Array(b64)
  return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
}

/**
 * Encode 16-bit unsigned integer to base64 (5 chars → 3 chars)
 */
function encodeUint16(num: number): string {
  const bytes = new Uint8Array(2)
  bytes[0] = (num >> 8) & 0xff
  bytes[1] = num & 0xff
  return uint8ArrayToBase64(bytes)
}

/**
 * Decode base64 back to 16-bit unsigned integer
 */
function decodeUint16(b64: string): number {
  const bytes = base64ToUint8Array(b64)
  return (bytes[0] << 8) | bytes[1]
}

/**
 * Encode SHA-256 fingerprint to base64 (95 chars → 44 chars)
 * e.g., "3B:F5:2E:05:..." → base64
 */
function encodeFingerprint(fp: string): string {
  const hexBytes = fp.split(':').map(h => parseInt(h, 16))
  return bytesToBase64(hexBytes)
}

/**
 * Decode base64 back to SHA-256 fingerprint
 */
function decodeFingerprint(b64: string): string {
  const bytes = base64ToBytes(b64)
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(':')
}

/**
 * Compress SDP by encoding the fingerprint (biggest savings)
 */
function compressSDP(sdp: string): string {
  // Replace fingerprint with compact form
  // a=fingerprint:sha-256 XX:XX:XX:... → a=fingerprint:sha-256 ~base64
  return sdp.replace(
    /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/,
    (_, fp) => `a=fingerprint:sha-256 ~${encodeFingerprint(fp)}`
  )
}

/**
 * Expand SDP by decoding the fingerprint
 */
function expandSDP(sdp: string): string {
  return sdp.replace(
    /a=fingerprint:sha-256 ~([A-Za-z0-9+/=]+)/,
    (_, b64) => `a=fingerprint:sha-256 ${decodeFingerprint(b64)}`
  )
}

/**
 * Convert full payload to minified format
 */
function minifyPayload(payload: QRSignalingPayload): MinifiedPayload {
  const minified: MinifiedPayload = {
    v: QR_FORMAT_VERSION,
    t: payload.type === 'offer' ? 'o' : 'a',
    s: compressSDP(payload.sdp), // Compress fingerprint in SDP
    c: payload.candidates.map(minifyCandidate),
  }

  // Add optional offer fields with compact encoding
  if (payload.salt) minified.x = bytesToBase64(payload.salt) // [1,2,3...] → base64
  if (payload.contentType) minified.ct = payload.contentType === 'file' ? 'f' : 't'
  if (payload.fileName) minified.fn = payload.fileName
  if (payload.fileSize !== undefined) minified.fs = payload.fileSize
  if (payload.mimeType) minified.mt = payload.mimeType
  if (payload.totalBytes !== undefined) minified.tb = payload.totalBytes

  return minified
}

/**
 * Convert minified format back to full payload
 */
function expandPayload(minified: MinifiedPayload): QRSignalingPayload {
  const payload: QRSignalingPayload = {
    type: minified.t === 'o' ? 'offer' : 'answer',
    sdp: expandSDP(minified.s), // Expand fingerprint in SDP
    candidates: minified.c.map(expandCandidate),
  }

  // Add optional offer fields with expansion
  if (minified.x) payload.salt = base64ToBytes(minified.x) // base64 → [1,2,3...]
  if (minified.ct) payload.contentType = minified.ct === 'f' ? 'file' : 'text'
  if (minified.fn) payload.fileName = minified.fn
  if (minified.fs !== undefined) payload.fileSize = minified.fs
  if (minified.mt) payload.mimeType = minified.mt
  if (minified.tb !== undefined) payload.totalBytes = minified.tb

  return payload
}

/**
 * Compress signaling payload for QR code
 * Uses minified JSON + gzip compression + base45 encoding
 * Base45 uses only QR alphanumeric characters for ~23% smaller QR codes
 */
export function compressSignalingData(payload: QRSignalingPayload): string {
  const minified = minifyPayload(payload)
  const json = JSON.stringify(minified)
  const compressed = pako.gzip(json)
  return base45Encode(compressed)
}

/**
 * Decompress signaling payload from QR code data (base45 encoded)
 */
export function decompressSignalingData(base45Data: string): QRSignalingPayload {
  const bytes = base45Decode(base45Data)
  const decompressed = pako.ungzip(bytes, { to: 'string' })
  const minified = JSON.parse(decompressed) as MinifiedPayload
  return expandPayload(minified)
}

/**
 * Generate offer QR data
 */
export function generateOfferQRData(
  offer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  salt: Uint8Array,
  metadata: {
    contentType: ContentType
    totalBytes: number
    fileName?: string
    fileSize?: number
    mimeType?: string
  }
): string {
  const payload: QRSignalingPayload = {
    type: 'offer',
    sdp: offer.sdp || '',
    candidates: candidates.map(c => c.candidate),
    salt: Array.from(salt),
    contentType: metadata.contentType,
    totalBytes: metadata.totalBytes,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
  }
  return compressSignalingData(payload)
}

/**
 * Generate answer QR data
 */
export function generateAnswerQRData(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[]
): string {
  const payload: QRSignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map(c => c.candidate),
  }
  return compressSignalingData(payload)
}

/**
 * Parse QR payload data
 * Returns null if invalid
 */
export function parseQRPayload(data: string): QRSignalingPayload | null {
  try {
    return decompressSignalingData(data)
  } catch {
    return null
  }
}

/**
 * Validate QR payload structure
 */
export function isValidQRPayload(payload: unknown): payload is QRSignalingPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (p.type !== 'offer' && p.type !== 'answer') return false
  if (typeof p.sdp !== 'string') return false
  if (!Array.isArray(p.candidates)) return false
  return true
}

/**
 * Estimate compressed size of payload (for UI feedback)
 */
export function estimateCompressedSize(payload: QRSignalingPayload): number {
  const compressed = compressSignalingData(payload)
  return compressed.length
}

/**
 * Max QR code capacity for alphanumeric data (version 40, L error correction)
 * In practice we use ~3KB limit for reliable scanning
 */
export const MAX_QR_DATA_SIZE = 3000

/**
 * Check if payload fits in QR code
 */
export function fitsInQRCode(payload: QRSignalingPayload): boolean {
  return estimateCompressedSize(payload) <= MAX_QR_DATA_SIZE
}
