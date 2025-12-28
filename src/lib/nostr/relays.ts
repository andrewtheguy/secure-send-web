// Core relays (always used)
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.rocks',
  'wss://relay.nostr.pub',
] as const

// Backup relays (used only when primary fails, probed with NIP-11)
export const BACKUP_RELAYS = [
  'wss://nostr.wine',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
  'wss://relay.snort.social',
  'wss://nostr.fmt.wiz.biz',
  'wss://relay.current.fyi',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.mom',
  'wss://relay.nostr.bg',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostr.info',
  'wss://nostr.bitcoiner.social',
  'wss://relay.nostr.ch',
  'wss://relay.nostrgraph.net',
  'wss://nostr.lu.ke',
] as const

export const MIN_CONNECTED_RELAYS = 2
export const NIP11_TIMEOUT_MS = 5000
