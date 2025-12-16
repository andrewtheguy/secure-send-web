// Event kinds (matching wormhole-rs)
export const EVENT_KIND_DATA_TRANSFER = 24242
export const EVENT_KIND_PIN_EXCHANGE = 24243

// Content types
export type ContentType = 'text' | 'file'

// Transfer states
export type TransferStatus =
  | 'idle'
  | 'connecting'
  | 'waiting_for_receiver'
  | 'transferring'
  | 'receiving'
  | 'complete'
  | 'error'

// File metadata
export interface FileMetadata {
  fileName: string
  fileSize: number
  mimeType: string
}

// Chunk status for detailed progress tracking
export type ChunkStatus = 'pending' | 'sending' | 'sent' | 'acked' | 'receiving' | 'received'

export interface ChunkState {
  seq: number
  status: ChunkStatus
  retries?: number
  timestamp?: number
}

export interface TransferState {
  status: TransferStatus
  message?: string
  progress?: {
    current: number
    total: number
  }
  relaysConnected?: number
  relaysTotal?: number
  contentType?: ContentType
  fileMetadata?: FileMetadata
  chunks?: Map<number, ChunkState>
  useWebRTC?: boolean
  currentRelays?: string[] // Current relay URLs being used
}

// PIN Exchange payload (encrypted in the event)
export interface PinExchangePayload {
  contentType: ContentType
  transferId: string
  senderPubkey: string
  totalChunks: number
  // Sender's preferred relays for data transfer
  relays?: string[]
  // For text (single chunk only)
  textMessage?: string
  // For file
  fileName?: string
  fileSize?: number
  mimeType?: string
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

// Received content
export interface ReceivedText {
  contentType: 'text'
  message: string
}

export interface ReceivedFile {
  contentType: 'file'
  data: Uint8Array
  fileName: string
  fileSize: number
  mimeType: string
}

export type ReceivedContent = ReceivedText | ReceivedFile

// WebRTC Signaling
export type SignalingType = 'offer' | 'answer' | 'candidate'

export interface SignalingPayload {
  type: SignalingType
  sdp?: string
  candidate?: RTCIceCandidateInit
}

export interface WebRTCOptions {
  relayOnly?: boolean
}
