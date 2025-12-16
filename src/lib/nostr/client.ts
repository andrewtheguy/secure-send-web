import { SimplePool, mergeFilters, type Event, type Filter } from 'nostr-tools'
import { DEFAULT_RELAYS } from './relays'

export class NostrClient {
  private pool: SimplePool
  private relays: string[]
  private subscriptions: Map<string, { close: () => void }>

  constructor(relays: string[] = [...DEFAULT_RELAYS]) {
    this.pool = new SimplePool()
    this.relays = relays
    this.subscriptions = new Map()
  }

  /**
   * Publish an event to all connected relays with retry
   */
  async publish(event: Event, maxRetries: number = 3): Promise<void> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await Promise.any(this.pool.publish(this.relays, event))
        return // Success
      } catch (err) {
        lastError = err as Error
        if (attempt < maxRetries - 1) {
          // Wait before retry (exponential backoff: 500ms, 1000ms, 2000ms)
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)))
        }
      }
    }

    // All retries failed
    console.error(`Failed to publish to any relay after ${maxRetries} attempts:`, {
      relays: this.relays,
      eventKind: event.kind,
      error: lastError?.message,
    })
    throw lastError
  }

  /**
   * Subscribe to events matching filters
   * Returns a subscription ID that can be used to unsubscribe
   */
  subscribe(
    filters: Filter[],
    onEvent: (event: Event) => void,
    onEose?: () => void
  ): string {
    const subId = crypto.randomUUID()
    if (filters.length === 0) {
      throw new Error('subscribe requires at least one filter')
    }
    const filter =
      filters.length === 1 ? filters[0] : mergeFilters(...filters)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = this.pool.subscribeMany(this.relays, filter as any, {
      onevent: onEvent,
      oneose: onEose,
    })

    this.subscriptions.set(subId, sub)
    return subId
  }

  /**
   * Unsubscribe from a specific subscription
   */
  unsubscribe(subId: string): void {
    const sub = this.subscriptions.get(subId)
    if (sub) {
      sub.close()
      this.subscriptions.delete(subId)
    }
  }

  /**
   * Query for events (one-time fetch)
   */
  async query(filters: Filter[]): Promise<Event[]> {
    const results: Event[] = []
    for (const filter of filters) {
      const events = await this.pool.querySync(this.relays, filter)
      results.push(...events)
    }
    return results
  }

  /**
   * Get a single event by filters
   */
  async get(filters: Filter[]): Promise<Event | null> {
    const events = await this.query(filters)
    return events[0] ?? null
  }

  /**
   * Close all subscriptions and the pool
   */
  close(): void {
    for (const sub of this.subscriptions.values()) {
      sub.close()
    }
    this.subscriptions.clear()
    this.pool.close(this.relays)
  }

  /**
   * Get the list of relays being used
   */
  getRelays(): string[] {
    return [...this.relays]
  }
}

/**
 * Create and return a NostrClient instance
 */
export function createNostrClient(relays?: string[]): NostrClient {
  return new NostrClient(relays)
}
