import { SimplePool, type Event, type Filter } from 'nostr-tools'
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
   * Publish an event to all connected relays
   */
  async publish(event: Event): Promise<void> {
    await Promise.any(this.pool.publish(this.relays, event))
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = this.pool.subscribeMany(this.relays, filters as any, {
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
