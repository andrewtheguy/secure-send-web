import { BACKUP_RELAYS, NIP11_TIMEOUT_MS } from './relays'

/** NIP-11 Relay Information Document */
export interface Nip11Info {
  name?: string
  description?: string
  pubkey?: string
  contact?: string
  supported_nips?: number[]
  software?: string
  version?: string
  limitation?: {
    max_message_length?: number
    max_subscriptions?: number
    max_filters?: number
    max_limit?: number
    max_subid_length?: number
    max_event_tags?: number
    max_content_length?: number
    min_pow_difficulty?: number
    auth_required?: boolean
    payment_required?: boolean
    restricted_writes?: boolean
    created_at_lower_limit?: number
    created_at_upper_limit?: number
  }
  relay_countries?: string[]
  language_tags?: string[]
  tags?: string[]
  posting_policy?: string
  payments_url?: string
  fees?: {
    admission?: { amount: number; unit: string }[]
    subscription?: { amount: number; unit: string; period: number }[]
    publication?: { kinds: number[]; amount: number; unit: string }[]
  }
  icon?: string
}

interface RelayProbeResult {
  url: string
  info: Nip11Info | null
  latencyMs: number
  error?: string
}

/** Normalize relay URL by removing trailing slashes */
function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Convert wss:// URL to https:// for NIP-11 fetch */
function relayUrlToHttps(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
}

/**
 * Fetch NIP-11 info document from a relay
 */
export async function fetchNip11Info(
  relayUrl: string,
  timeoutMs: number = NIP11_TIMEOUT_MS
): Promise<{ info: Nip11Info | null; latencyMs: number }> {
  const startTime = performance.now()
  const httpUrl = relayUrlToHttps(relayUrl)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(httpUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/nostr+json',
      },
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    const latencyMs = Math.round(performance.now() - startTime)

    if (!response.ok) {
      return { info: null, latencyMs }
    }

    const info = (await response.json()) as Nip11Info
    return { info, latencyMs }
  } catch {
    clearTimeout(timeoutId)
    const latencyMs = Math.round(performance.now() - startTime)
    return { info: null, latencyMs }
  }
}

/**
 * Check if a relay is suitable for our use case
 */
function isRelaySuitable(info: Nip11Info): boolean {
  if (info.limitation?.auth_required) {
    return false
  }

  if (info.limitation?.payment_required) {
    return false
  }

  if (info.fees?.admission && info.fees.admission.length > 0) {
    return false
  }

  if (info.fees?.subscription && info.fees.subscription.length > 0) {
    return false
  }

  if (info.limitation?.restricted_writes) {
    return false
  }

  return true
}

/**
 * Calculate a score for relay selection (higher = better)
 */
function calculateRelayScore(info: Nip11Info, latencyMs: number): number {
  let score = 0

  // Latency component (lower is better, max 50 points)
  score += Math.max(0, 50 - latencyMs / 50)

  // NIP support component
  const supportedNips = info.supported_nips || []
  if (supportedNips.includes(1)) score += 5
  if (supportedNips.includes(11)) score += 5
  if (supportedNips.includes(15)) score += 5
  if (supportedNips.includes(20)) score += 5
  if (supportedNips.includes(40)) score += 5

  // Capacity component
  const maxContentLength = info.limitation?.max_content_length || 0
  if (maxContentLength >= 64000) score += 10
  if (maxContentLength >= 128000) score += 10

  return score
}

/**
 * Probe multiple relays in parallel
 */
async function probeRelays(
  relayUrls: string[],
  timeoutMs: number = NIP11_TIMEOUT_MS
): Promise<RelayProbeResult[]> {
  const probePromises = relayUrls.map(async (url): Promise<RelayProbeResult> => {
    try {
      const { info, latencyMs } = await fetchNip11Info(url, timeoutMs)
      return { url, info, latencyMs }
    } catch (error) {
      return {
        url,
        info: null,
        latencyMs: timeoutMs,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  return Promise.all(probePromises)
}

/**
 * Get backup relays when primary relays fail.
 * Probes BACKUP_RELAYS with NIP-11 to find the best available relays.
 */
export async function discoverBackupRelays(
  excludeRelays: string[],
  count: number = 5
): Promise<string[]> {
  const excludeSet = new Set(excludeRelays.map(normalizeRelayUrl))

  const candidates = [...BACKUP_RELAYS]
    .map(normalizeRelayUrl)
    .filter((url) => !excludeSet.has(url))

  if (candidates.length === 0) {
    console.warn('No backup relay candidates available')
    return []
  }

  console.log(`Probing ${candidates.length} backup relay candidates...`)

  const results = await probeRelays(candidates)

  const scoredRelays = results
    .filter((r): r is RelayProbeResult & { info: Nip11Info } => {
      if (!r.info) {
        console.log(`  ${r.url}: NIP-11 fetch failed`)
        return false
      }
      if (!isRelaySuitable(r.info)) {
        console.log(`  ${r.url}: Filtered (auth/payment required)`)
        return false
      }
      return true
    })
    .map((r) => ({
      url: r.url,
      score: calculateRelayScore(r.info, r.latencyMs),
      latencyMs: r.latencyMs,
      name: r.info.name || r.url,
    }))
    .sort((a, b) => b.score - a.score)

  const selected = scoredRelays.slice(0, count)

  for (const relay of selected) {
    console.log(
      `  Selected: ${relay.name} (score: ${relay.score.toFixed(1)}, latency: ${relay.latencyMs}ms)`
    )
  }

  return selected.map((r) => r.url)
}
