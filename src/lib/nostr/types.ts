// Event kinds (matching wormhole-rs)
export const EVENT_KIND_DATA_TRANSFER = 24242
export const EVENT_KIND_PIN_EXCHANGE = 24243

// Transfer states
export type TransferStatus =
  | 'idle'
  | 'connecting'
  | 'waiting_for_receiver'
  | 'transferring'
  | 'receiving'
  | 'complete'
  | 'error'

export interface TransferState {
  status: TransferStatus
  message?: string
  progress?: {
    current: number
    total: number
  }
  relaysConnected?: number
  relaysTotal?: number
}

// PIN Exchange payload (encrypted in the event)
export interface PinExchangePayload {
  message: string
  transferId: string
  senderPubkey: string
  totalChunks: number
}

// Data chunk payload
export interface ChunkData {
  transferId: string
  seq: number
  total: number
  data: string // base64 encrypted chunk
}

// ACK payload
export interface AckData {
  transferId: string
  seq: number // -1 for final completion ACK, 0 for ready
}

// Transfer metadata
export interface TransferMetadata {
  pin: string
  pinHint: string
  salt: Uint8Array
  key: CryptoKey
  transferId: string
  secretKey: Uint8Array
  publicKey: string
}
