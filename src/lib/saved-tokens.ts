/**
 * Utility for managing saved mutual contact tokens in localStorage
 * Stores the last 5 successfully used tokens for quick access
 */

const STORAGE_KEY = 'saved_mutual_tokens'
const MAX_SAVED_TOKENS = 5

export interface SavedToken {
  token: string
  partyAFingerprint: string
  partyBFingerprint: string
  comment?: string
  lastUsed: number // timestamp
}

/**
 * Get all saved tokens, sorted by most recently used
 */
export function getSavedTokens(): SavedToken[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const tokens = JSON.parse(stored) as SavedToken[]
    // Sort by most recently used
    return tokens.sort((a, b) => b.lastUsed - a.lastUsed)
  } catch {
    return []
  }
}

/**
 * Save a token after successful transfer
 * Updates lastUsed if token already exists, otherwise adds to list
 * Keeps only the last MAX_SAVED_TOKENS tokens
 */
export function saveToken(
  token: string,
  partyAFingerprint: string,
  partyBFingerprint: string,
  comment?: string
): void {
  try {
    const tokens = getSavedTokens()
    const now = Date.now()

    // Check if token already exists (by matching the token string)
    const existingIndex = tokens.findIndex((t) => t.token === token)

    if (existingIndex >= 0) {
      // Update existing token's lastUsed time and comment
      tokens[existingIndex].lastUsed = now
      if (comment !== undefined) {
        tokens[existingIndex].comment = comment
      }
    } else {
      // Add new token
      tokens.unshift({
        token,
        partyAFingerprint,
        partyBFingerprint,
        comment,
        lastUsed: now,
      })
    }

    // Keep only the most recent MAX_SAVED_TOKENS
    const trimmed = tokens.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_SAVED_TOKENS)

    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/**
 * Remove a specific token from saved list
 */
export function removeToken(token: string): void {
  try {
    const tokens = getSavedTokens().filter((t) => t.token !== token)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens))
  } catch {
    // Silently fail
  }
}

/**
 * Clear all saved tokens
 */
export function clearSavedTokens(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Silently fail
  }
}
