/**
 * Base45 encoding/decoding for QR code optimization
 *
 * Base45 uses only QR alphanumeric characters (0-9, A-Z, space, $%*+-./: )
 * which allows QR codes to use alphanumeric mode (5.5 bits/char) instead of
 * byte mode (8 bits/char), resulting in ~23% smaller QR codes.
 *
 * Reference: RFC 9285 - https://datatracker.ietf.org/doc/html/rfc9285
 */

const BASE = 45
const BASE_SQUARED = BASE * BASE
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

// Build decode map
const DECODE_MAP = new Map<string, number>()
for (let i = 0; i < CHARSET.length; i++) {
  DECODE_MAP.set(CHARSET[i], i)
}

/**
 * Encode binary data to base45 string
 */
export function base45Encode(data: Uint8Array): string {
  const result: string[] = []

  // Process pairs of bytes (2 bytes -> 3 chars)
  for (let i = 0; i < data.length - 1; i += 2) {
    const value = (data[i] << 8) | data[i + 1]
    result.push(CHARSET[value % BASE])
    result.push(CHARSET[Math.floor(value / BASE) % BASE])
    result.push(CHARSET[Math.floor(value / BASE_SQUARED) % BASE])
  }

  // Handle odd byte (1 byte -> 2 chars)
  if (data.length % 2 === 1) {
    const value = data[data.length - 1]
    result.push(CHARSET[value % BASE])
    result.push(CHARSET[Math.floor(value / BASE) % BASE])
  }

  return result.join('')
}

/**
 * Decode base45 string to binary data
 */
export function base45Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0)

  if (str.length % 3 === 1) {
    throw new Error(`Invalid base45 string length: ${str.length}`)
  }

  // Decode characters to values
  const values: number[] = []
  for (let i = 0; i < str.length; i++) {
    const val = DECODE_MAP.get(str[i])
    if (val === undefined) {
      throw new Error(`Invalid base45 character '${str[i]}' at position ${i}`)
    }
    values.push(val)
  }

  // Calculate result size
  const fullChunks = Math.floor(values.length / 3)
  const hasRemainder = values.length % 3 === 2
  const result = new Uint8Array(fullChunks * 2 + (hasRemainder ? 1 : 0))

  // Process triplets (3 chars -> 2 bytes)
  for (let i = 0; i < values.length - 2; i += 3) {
    const value = values[i] + BASE * values[i + 1] + BASE_SQUARED * values[i + 2]
    const resultIndex = (2 * i) / 3
    result[resultIndex] = value >> 8
    result[resultIndex + 1] = value & 0xff
  }

  // Handle remainder (2 chars -> 1 byte)
  if (hasRemainder) {
    result[result.length - 1] = values[values.length - 2] + BASE * values[values.length - 1]
  }

  return result
}
