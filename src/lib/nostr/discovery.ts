import { SimplePool } from 'nostr-tools'
import { DEFAULT_RELAYS } from './relays'

interface RelayInfo {
  url: string
  latency: number
  supported: boolean
}

/** Normalize relay URL by removing trailing slashes */
function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

interface RelayCapabilities {
  limitation?: {
    max_message_length?: number
    max_content_length?: number
    payment_required?: boolean
    auth_required?: boolean
  }
}

const KIND_NIP65_RELAY_LIST = 10002
const KIND_NIP66_RELAY_DISCOVERY = 30166

const PROBE_TIMEOUT_MS = 5000
const MIN_MESSAGE_LENGTH = 24 * 1024
const MAX_RELAYS_TO_PROBE = 30
const TOP_RELAYS_COUNT = 5
const CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours
const CACHE_KEY_ALL_DISCOVERED = 'nostr_all_discovered'

interface CachedRelays {
  relays: string[]
  timestamp: number
}

function getCachedDiscoveredRelays(): string[] | null {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY_ALL_DISCOVERED)
    if (!cached) return null

    const parsed: CachedRelays = JSON.parse(cached)
    const age = Date.now() - parsed.timestamp

    if (age > CACHE_TTL_MS) {
      sessionStorage.removeItem(CACHE_KEY_ALL_DISCOVERED)
      return null
    }

    return parsed.relays
  } catch {
    return null
  }
}

function setCachedDiscoveredRelays(relays: string[]): void {
  try {
    const data: CachedRelays = {
      relays,
      timestamp: Date.now()
    }
    sessionStorage.setItem(CACHE_KEY_ALL_DISCOVERED, JSON.stringify(data))
  } catch {
    // sessionStorage may be unavailable or full
  }
}

/**
 * Clear the relay discovery cache
 */
export function clearRelayCache(): void {
  try {
    sessionStorage.removeItem(CACHE_KEY_ALL_DISCOVERED)
    cachedDiscoveredUrls = []
    console.log('Relay cache cleared')
  } catch {
    // ignore
  }
}

/**
 * Check if relay cache exists and is valid
 */
export function hasRelayCache(): boolean {
  return getCachedDiscoveredRelays() !== null
}

// In-memory fallback for backup discovery
let cachedDiscoveredUrls: string[] = []

async function discoverRelaysFromSeeds(seedRelays: string[]): Promise<string[]> {
  const discovered = new Set<string>()
  const pool = new SimplePool()

  try {
    const events = await pool.querySync(seedRelays, {
      kinds: [KIND_NIP65_RELAY_LIST, KIND_NIP66_RELAY_DISCOVERY],
      limit: 100,
    })

    for (const event of events) {
      for (const tag of event.tags) {
        if ((tag[0] === 'r' || tag[0] === 'd') && tag[1]) {
          const url = normalizeRelayUrl(tag[1])
          if (url.startsWith('wss://') || url.startsWith('ws://')) {
            discovered.add(url)
          }
        }
      }
    }
  } catch (err) {
    console.warn('Relay discovery query failed:', err)
  } finally {
    pool.close(seedRelays)
  }

  return Array.from(discovered)
}

async function fetchRelayInfo(relayUrl: string): Promise<RelayCapabilities | null> {
  const httpUrl = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://')

  try {
    const response = await fetch(httpUrl, {
      headers: { 'Accept': 'application/nostr+json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

function isRelaySuitable(info: RelayCapabilities): boolean {
  const lim = info.limitation
  if (!lim) return true
  if (lim.max_message_length && lim.max_message_length < MIN_MESSAGE_LENGTH) return false
  if (lim.max_content_length && lim.max_content_length < MIN_MESSAGE_LENGTH) return false
  if (lim.payment_required) return false
  if (lim.auth_required) return false
  return true
}

async function testRelayLatency(relayUrl: string): Promise<number | null> {
  const start = performance.now()

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close()
      resolve(null)
    }, PROBE_TIMEOUT_MS)

    const ws = new WebSocket(relayUrl)

    ws.onopen = () => {
      clearTimeout(timeout)
      const latency = performance.now() - start
      ws.close()
      resolve(latency)
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      resolve(null)
    }
  })
}

export async function discoverBestRelays(
  seedRelays: readonly string[] = DEFAULT_RELAYS
): Promise<string[]> {
  const seeds = [...seedRelays].map(normalizeRelayUrl)

  // Check sessionStorage cache first
  const cached = getCachedDiscoveredRelays()
  let allRelays: string[]

  if (cached && cached.length > 0) {
    console.log(`Using ${cached.length} cached discovered relays`)
    allRelays = cached
  } else {
    // 1. Discover additional relays from NIP-65/NIP-66 events
    const discoveredRelays = await discoverRelaysFromSeeds(seeds)

    // 2. Combine seed relays with discovered relays (deduped, normalized)
    allRelays = [...new Set([...seeds, ...discoveredRelays])]

    // Cache to sessionStorage (4 hour TTL)
    setCachedDiscoveredRelays(allRelays)
    console.log(`Cached ${allRelays.length} discovered relays`)
  }

  const relaysToProbe = allRelays.slice(0, MAX_RELAYS_TO_PROBE)

  // Also keep in-memory for backup discovery
  cachedDiscoveredUrls = allRelays

  console.log(`Probing ${relaysToProbe.length} relays`)

  // 3. Probe all relays in parallel
  const probeResults = await Promise.all(
    relaysToProbe.map(async (url): Promise<RelayInfo | null> => {
      const info = await fetchRelayInfo(url)
      if (info && !isRelaySuitable(info)) {
        return null
      }

      const latency = await testRelayLatency(url)
      if (latency === null) return null

      return { url, latency, supported: true }
    })
  )

  // 4. Filter successful probes, sort by latency
  const validRelays = probeResults
    .filter((r): r is RelayInfo => r !== null)
    .sort((a, b) => a.latency - b.latency)
    .slice(0, TOP_RELAYS_COUNT)
    .map(r => r.url)

  console.log(`Selected ${validRelays.length} best relays:`, validRelays)

  // 5. Fallback to defaults if discovery fails
  if (validRelays.length === 0) {
    console.warn('Relay discovery failed, using defaults')
    return seeds.slice(0, TOP_RELAYS_COUNT)
  }

  return validRelays
}

/**
 * Discover backup relays when primary relays fail.
 * Only probes relays not in the exclude list, avoiding extra work until needed.
 */
export async function discoverBackupRelays(
  excludeRelays: string[],
  count: number = 5
): Promise<string[]> {
  const excludeSet = new Set(excludeRelays.map(normalizeRelayUrl))

  // Use cached discovered URLs, excluding already-tried relays
  let candidates = cachedDiscoveredUrls.filter(url => !excludeSet.has(url))

  // If no cache or exhausted, use DEFAULT_RELAYS as fallback
  if (candidates.length === 0) {
    candidates = [...DEFAULT_RELAYS]
      .map(normalizeRelayUrl)
      .filter(url => !excludeSet.has(url))
  }

  if (candidates.length === 0) {
    console.warn('No backup relay candidates available')
    return []
  }

  console.log(`Probing ${candidates.length} backup relay candidates`)

  // Probe candidates in parallel
  const probeResults = await Promise.all(
    candidates.slice(0, MAX_RELAYS_TO_PROBE).map(async (url): Promise<RelayInfo | null> => {
      const info = await fetchRelayInfo(url)
      if (info && !isRelaySuitable(info)) {
        return null
      }

      const latency = await testRelayLatency(url)
      if (latency === null) return null

      return { url, latency, supported: true }
    })
  )

  const backupRelays = probeResults
    .filter((r): r is RelayInfo => r !== null)
    .sort((a, b) => a.latency - b.latency)
    .slice(0, count)
    .map(r => r.url)

  console.log(`Found ${backupRelays.length} backup relays:`, backupRelays)

  return backupRelays
}
