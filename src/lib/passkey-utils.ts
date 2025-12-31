/** Maximum acceptable clock skew for future timestamps (5 minutes in ms) */
const MAX_ACCEPTABLE_CLOCK_SKEW_MS = 5 * 60 * 1000

/** Expected byte length for id and ppk fields (32 bytes each) */
const EXPECTED_ID_LENGTH = 32
const EXPECTED_PPK_LENGTH = 32

/** Convert Uint8Array to base64 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''))
}

/**
 * Convert base64 to Uint8Array.
 * @param base64 - Base64 encoded string
 * @returns Uint8Array if valid base64, null if malformed
 */
export function base64ToUint8Array(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    // Invalid base64 encoding
    return null
  }
}

/** Invite code format */
export interface InviteCode {
  id: string
  ppk: string
  iat: number
}

/**
 * Parse and validate invite code from JSON.
 *
 * Validates:
 * - JSON structure with id, ppk, and iat fields
 * - id and ppk are non-empty strings with valid base64 encoding
 * - id decodes to exactly 32 bytes
 * - ppk decodes to exactly 32 bytes
 * - iat is a finite positive Unix timestamp
 * - iat is not too far in the future (max 5 minutes clock skew)
 *
 * @param input - JSON string to parse
 * @returns InviteCode if valid, null otherwise
 */
export function parseInviteCode(input: string): InviteCode | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }

    const obj = parsed as Record<string, unknown>

    // Check required fields exist and have correct types
    if (
      typeof obj.id !== 'string' ||
      typeof obj.ppk !== 'string' ||
      typeof obj.iat !== 'number'
    ) {
      return null
    }

    const { id, ppk, iat } = obj as { id: string; ppk: string; iat: number }

    // Validate non-empty strings
    if (!id || !ppk) {
      return null
    }

    // Validate iat is a finite positive timestamp
    if (!Number.isFinite(iat) || iat <= 0) {
      return null
    }

    // Validate iat is not too far in the future
    const nowMs = Date.now()
    const iatMs = iat * 1000
    if (iatMs > nowMs + MAX_ACCEPTABLE_CLOCK_SKEW_MS) {
      return null
    }

    // Validate id is valid base64 with expected length
    const idBytes = base64ToUint8Array(id)
    if (!idBytes || idBytes.length !== EXPECTED_ID_LENGTH) {
      return null
    }

    // Validate ppk is valid base64 with expected length
    const ppkBytes = base64ToUint8Array(ppk)
    if (!ppkBytes || ppkBytes.length !== EXPECTED_PPK_LENGTH) {
      return null
    }

    return { id, ppk, iat }
  } catch {
    // JSON parsing failed
    return null
  }
}
