import { DEFAULT_RELAYS } from './relays'

const RELAY_PROBE_TIMEOUT = 3000

export interface RelayAvailabilityResult {
  available: boolean
  connectedRelays: string[]
  error?: string
}

/**
 * Simple probe - just check if relay is reachable via WebSocket
 * Closes connection immediately after success
 */
async function probeRelay(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), RELAY_PROBE_TIMEOUT)

    try {
      const ws = new WebSocket(url)
      ws.onopen = () => {
        clearTimeout(timeout)
        ws.close()
        resolve(url)
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        resolve(null)
      }
    } catch {
      clearTimeout(timeout)
      resolve(null)
    }
  })
}

/**
 * Test Nostr relay availability by attempting WebSocket connections.
 * Probes all relays in parallel and returns which ones are available.
 *
 * @param relays - Relay URLs to test (defaults to DEFAULT_RELAYS)
 */
export async function testRelayAvailability(
  relays: string[] = [...DEFAULT_RELAYS]
): Promise<RelayAvailabilityResult> {
  try {
    const results = await Promise.all(relays.map(url => probeRelay(url)))
    const connectedRelays = results.filter((r): r is string => r !== null)

    return {
      available: connectedRelays.length > 0,
      connectedRelays,
    }
  } catch (error) {
    return {
      available: false,
      connectedRelays: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
