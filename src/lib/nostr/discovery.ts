import { DEFAULT_RELAYS } from './relays'

/** Normalize relay URL by removing trailing slashes */
function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Get backup relays when primary relays fail.
 * Returns DEFAULT_RELAYS excluding already-tried relays.
 */
export async function discoverBackupRelays(
  excludeRelays: string[],
  count: number = 5
): Promise<string[]> {
  const excludeSet = new Set(excludeRelays.map(normalizeRelayUrl))

  const candidates = [...DEFAULT_RELAYS]
    .map(normalizeRelayUrl)
    .filter(url => !excludeSet.has(url))

  if (candidates.length === 0) {
    console.warn('No backup relay candidates available')
    return []
  }

  console.log(`Found ${candidates.length} backup relay candidates`)
  return candidates.slice(0, count)
}
