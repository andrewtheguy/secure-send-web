# Relay Discovery for Nostr Transfers

## Overview
Implement relay discovery logic similar to wormhole-rs to automatically discover relays via NIP-65/NIP-66, check capabilities, and select the best relays based on latency.

## Current State
- 5 hardcoded relays in `src/lib/nostr/relays.ts`
- NostrClient uses all relays without selection
- No discovery, health checks, or latency testing

## Target Behavior (from wormhole-rs)
1. Start with seed relays (hardcoded defaults)
2. Query seed relays for NIP-66 (kind 30166) relay discovery events
3. Query seed relays for NIP-65 (kind 10002) relay list metadata
4. Combine discovered relays with seed relays
5. Probe each relay for capabilities (NIP-11)
6. Test WebSocket connectivity and measure latency
7. Sort by latency, select top N fastest
8. Fallback to defaults if discovery fails

## Critical Files
- `src/lib/nostr/relays.ts` - Relay constants
- `src/lib/nostr/client.ts` - NostrClient
- **New**: `src/lib/nostr/discovery.ts` - Relay discovery logic

## Implementation Steps

### Step 1: Create discovery module (`src/lib/nostr/discovery.ts`)

```typescript
interface RelayInfo {
  url: string
  latency: number  // ms
  supported: boolean
}

interface RelayCapabilities {
  maxMessageLength?: number
  maxContentLength?: number
  paymentRequired?: boolean
  authRequired?: boolean
}

// NIP event kinds
const KIND_NIP65_RELAY_LIST = 10002
const KIND_NIP66_RELAY_DISCOVERY = 30166

// Constants
const PROBE_TIMEOUT_MS = 5000
const DISCOVERY_TIMEOUT_MS = 10000
const MIN_MESSAGE_LENGTH = 24 * 1024  // 24KB for 16KB chunk + base64
const MAX_RELAYS_TO_PROBE = 30
const TOP_RELAYS_COUNT = 3
```

### Step 2: Implement NIP-65/NIP-66 relay discovery from network

```typescript
async function discoverRelaysFromSeeds(seedRelays: string[]): Promise<string[]> {
  const discovered = new Set<string>()

  // Use nostr-tools SimplePool for quick queries
  const pool = new SimplePool()

  try {
    // Query for NIP-66 relay discovery events (kind 30166)
    // and NIP-65 relay list metadata (kind 10002)
    const events = await pool.querySync(seedRelays, {
      kinds: [KIND_NIP65_RELAY_LIST, KIND_NIP66_RELAY_DISCOVERY],
      limit: 100,
    })

    for (const event of events) {
      // Extract relay URLs from tags
      for (const tag of event.tags) {
        // NIP-65 uses 'r' tags for relay URLs
        // NIP-66 uses 'd' tag for relay URL
        if ((tag[0] === 'r' || tag[0] === 'd') && tag[1]) {
          const url = tag[1]
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
```

### Step 3: Implement NIP-11 relay info fetching

```typescript
async function fetchRelayInfo(relayUrl: string): Promise<RelayCapabilities | null> {
  // Convert wss:// to https:// for NIP-11 HTTP request
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
  // Check message size limits
  if (info.maxMessageLength && info.maxMessageLength < MIN_MESSAGE_LENGTH) return false
  if (info.maxContentLength && info.maxContentLength < MIN_MESSAGE_LENGTH) return false
  // Check restrictions
  if (info.paymentRequired) return false
  if (info.authRequired) return false
  return true
}
```

### Step 4: Implement WebSocket latency testing

```typescript
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
```

### Step 5: Implement main discovery function

```typescript
export async function discoverBestRelays(
  seedRelays: string[] = DEFAULT_RELAYS
): Promise<string[]> {
  // 1. Discover additional relays from NIP-65/NIP-66 events
  const discoveredRelays = await discoverRelaysFromSeeds(seedRelays)

  // 2. Combine seed relays with discovered relays (deduped)
  const allRelays = [...new Set([...seedRelays, ...discoveredRelays])]
  const relaysToProbe = allRelays.slice(0, MAX_RELAYS_TO_PROBE)

  console.log(`Probing ${relaysToProbe.length} relays (${seedRelays.length} seeds + ${discoveredRelays.length} discovered)`)

  // 3. Probe all relays in parallel
  const probeResults = await Promise.all(
    relaysToProbe.map(async (url): Promise<RelayInfo | null> => {
      // Check NIP-11 capabilities (optional - many relays don't support)
      const info = await fetchRelayInfo(url)
      if (info && !isRelaySuitable(info)) {
        return null
      }

      // Test latency
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
    return seedRelays.slice(0, TOP_RELAYS_COUNT)
  }

  return validRelays
}
```

### Step 6: Update hooks to use discovery

In `use-nostr-send.ts` and `use-nostr-receive.ts`:

```typescript
// Before connecting:
setState({ status: 'connecting', message: 'Discovering best relays...' })
const bestRelays = await discoverBestRelays()

// Create client with discovered relays
const client = createNostrClient(bestRelays)
```

### Step 7: Export from nostr index

In `src/lib/nostr/index.ts`:
```typescript
export { discoverBestRelays } from './discovery'
```

## Configuration Constants (in relays.ts)

```typescript
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.wine',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
] as const

export const DISCOVERY_CONFIG = {
  probeTimeoutMs: 5000,
  minMessageLength: 24 * 1024,
  maxRelaysToProbe: 20,
  topRelaysCount: 3,
}
```

## Testing
1. Test with all relays available - should pick fastest 3
2. Test with some relays down - should skip unavailable ones
3. Test with all relays down - should fallback to defaults
4. Verify transfer works with discovered relays
5. Verify NIP-65/NIP-66 discovery finds additional relays

## Future Enhancements (not in scope)
- Relay health monitoring during transfer
- User-configurable relay list
- Caching discovered relays with TTL
- UI to show which relays were selected
