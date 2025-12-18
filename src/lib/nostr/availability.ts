import { DEFAULT_RELAYS, RELAY_CONNECT_TIMEOUT_MS } from './relays'

export interface RelayAvailabilityResult {
  available: boolean
  connectedRelays: string[]
  error?: string
}

/**
 * Test Nostr relay availability by attempting WebSocket connections.
 * Returns quickly with availability status.
 *
 * @param relays - Relay URLs to test (defaults to DEFAULT_RELAYS)
 * @param minConnections - Minimum connections required for "available" (default: 1)
 * @param timeoutMs - Timeout in milliseconds (default: RELAY_CONNECT_TIMEOUT_MS)
 */
export async function testRelayAvailability(
  relays: string[] = [...DEFAULT_RELAYS],
  minConnections: number = 1,
  timeoutMs: number = RELAY_CONNECT_TIMEOUT_MS
): Promise<RelayAvailabilityResult> {
  const connectedRelays: string[] = []
  const sockets: WebSocket[] = []

  try {
    const connectionPromises = relays.map(async (relay) => {
      return new Promise<string | null>((resolve) => {
        try {
          const ws = new WebSocket(relay)
          sockets.push(ws)

          const timeout = setTimeout(() => {
            ws.close()
            resolve(null)
          }, timeoutMs)

          ws.onopen = () => {
            clearTimeout(timeout)
            resolve(relay)
          }

          ws.onerror = () => {
            clearTimeout(timeout)
            resolve(null)
          }
        } catch {
          resolve(null)
        }
      })
    })

    const results = await Promise.allSettled(connectionPromises)

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        connectedRelays.push(result.value)
      }
    }

    return {
      available: connectedRelays.length >= minConnections,
      connectedRelays,
    }
  } catch (error) {
    return {
      available: false,
      connectedRelays: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  } finally {
    // Clean up all WebSocket connections
    for (const ws of sockets) {
      try {
        ws.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}
