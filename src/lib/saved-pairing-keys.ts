/**
 * Utility for managing saved pairing keys in localStorage
 * Stores the last 5 successfully used pairing keys for quick access
 */

const STORAGE_KEY = 'saved_pairing_keys'
const MAX_SAVED_PAIRING_KEYS = 5

export interface SavedPairingKey {
  pairingKey: string
  partyAFingerprint: string
  partyBFingerprint: string
  comment?: string
  lastUsed: number // timestamp
}

/**
 * Validate that a value is a valid SavedPairingKey
 */
function isValidSavedPairingKey(value: unknown): value is SavedPairingKey {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  // Support both old 'token' field and new 'pairingKey' field for migration
  const hasPairingKey = typeof obj.pairingKey === 'string' || typeof obj.token === 'string'
  return (
    hasPairingKey &&
    typeof obj.partyAFingerprint === 'string' &&
    typeof obj.partyBFingerprint === 'string' &&
    typeof obj.lastUsed === 'number' &&
    (obj.comment === undefined || typeof obj.comment === 'string')
  )
}

/**
 * Migrate old format to new format
 */
function migrateToNewFormat(value: Record<string, unknown>): SavedPairingKey {
  return {
    pairingKey: (value.pairingKey ?? value.token) as string,
    partyAFingerprint: value.partyAFingerprint as string,
    partyBFingerprint: value.partyBFingerprint as string,
    comment: value.comment as string | undefined,
    lastUsed: value.lastUsed as number,
  }
}

/**
 * Get all saved pairing keys, sorted by most recently used
 */
export function getSavedPairingKeys(): SavedPairingKey[] {
  try {
    // Try new storage key first
    let stored = localStorage.getItem(STORAGE_KEY)

    // Fall back to old storage key for migration
    if (!stored) {
      stored = localStorage.getItem('saved_mutual_tokens')
      if (stored) {
        // Migrate to new key
        localStorage.setItem(STORAGE_KEY, stored)
        localStorage.removeItem('saved_mutual_tokens')
      }
    }

    if (!stored) return []

    const parsed: unknown = JSON.parse(stored)

    // Validate it's an array
    if (!Array.isArray(parsed)) {
      console.error('Invalid saved pairing keys format: expected array')
      localStorage.removeItem(STORAGE_KEY)
      return []
    }

    // Validate each element and filter out invalid ones
    const validPairingKeys: SavedPairingKey[] = []
    let hasInvalid = false
    let needsMigration = false

    for (const item of parsed) {
      if (isValidSavedPairingKey(item)) {
        const itemAny = item as unknown as Record<string, unknown>
        const migrated = migrateToNewFormat(itemAny)
        if (itemAny.token !== undefined) {
          needsMigration = true
        }
        validPairingKeys.push(migrated)
      } else {
        hasInvalid = true
      }
    }

    // If some pairing keys were invalid or needed migration, update storage
    if (hasInvalid || needsMigration) {
      if (hasInvalid) {
        console.error('Some saved pairing keys had invalid format and were removed')
      }
      if (validPairingKeys.length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(validPairingKeys))
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    }

    // Sort by most recently used
    return validPairingKeys.sort((a, b) => b.lastUsed - a.lastUsed)
  } catch {
    return []
  }
}

/**
 * Save a pairing key after successful transfer
 * Updates lastUsed if pairing key already exists, otherwise adds to list
 * Keeps only the last MAX_SAVED_PAIRING_KEYS pairing keys
 */
export function savePairingKey(
  pairingKey: string,
  partyAFingerprint: string,
  partyBFingerprint: string,
  comment?: string
): void {
  try {
    const pairingKeys = getSavedPairingKeys()
    const now = Date.now()

    // Check if pairing key already exists (by matching the pairing key string)
    const existingIndex = pairingKeys.findIndex((pk) => pk.pairingKey === pairingKey)

    if (existingIndex >= 0) {
      // Update existing pairing key's lastUsed time and comment
      pairingKeys[existingIndex].lastUsed = now
      if (comment !== undefined) {
        pairingKeys[existingIndex].comment = comment
      }
    } else {
      // Add new pairing key
      pairingKeys.unshift({
        pairingKey,
        partyAFingerprint,
        partyBFingerprint,
        comment,
        lastUsed: now,
      })
    }

    // Keep only the most recent MAX_SAVED_PAIRING_KEYS
    const trimmed = pairingKeys.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_SAVED_PAIRING_KEYS)

    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/**
 * Remove a specific pairing key from saved list
 */
export function removePairingKey(pairingKey: string): void {
  try {
    const pairingKeys = getSavedPairingKeys().filter((pk) => pk.pairingKey !== pairingKey)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pairingKeys))
  } catch {
    // Silently fail
  }
}

/**
 * Clear all saved pairing keys
 */
export function clearSavedPairingKeys(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Silently fail
  }
}

// Legacy aliases for backward compatibility during migration
/** @deprecated Use SavedPairingKey instead */
export type SavedToken = SavedPairingKey
/** @deprecated Use getSavedPairingKeys instead */
export const getSavedTokens = getSavedPairingKeys
/** @deprecated Use savePairingKey instead */
export const saveToken = savePairingKey
/** @deprecated Use removePairingKey instead */
export const removeToken = removePairingKey
/** @deprecated Use clearSavedPairingKeys instead */
export const clearSavedTokens = clearSavedPairingKeys
