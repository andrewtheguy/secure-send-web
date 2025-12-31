// Helper to convert Uint8Array to base64
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''))
}

// Helper to convert base64 to Uint8Array
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Invite code format
export interface InviteCode {
  id: string
  ppk: string
  iat: number
}

// Parse invite code from JSON
export function parseInviteCode(input: string): InviteCode | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
      const obj = parsed as Record<string, unknown>
      if (
        typeof obj.id === 'string' &&
        typeof obj.ppk === 'string' &&
        typeof obj.iat === 'number' &&
        Number.isFinite(obj.iat)
      ) {
        return { id: obj.id, ppk: obj.ppk, iat: obj.iat }
      }
    }
  } catch {
    // Not JSON
  }

  return null
}
