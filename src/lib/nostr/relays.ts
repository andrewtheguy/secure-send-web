// Hardcoded reliable public Nostr relays
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.wine',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
] as const

export const MIN_CONNECTED_RELAYS = 2
export const RELAY_CONNECT_TIMEOUT_MS = 5000
