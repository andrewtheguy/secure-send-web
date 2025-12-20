// Event kinds (matching wormhole-rs)
export const EVENT_KIND_DATA_TRANSFER = 24242
export const EVENT_KIND_PIN_EXCHANGE = 24243

// Content types
export type ContentType = 'file'

// Transfer states
export type TransferStatus =
  | 'idle'
  | 'connecting'
  | 'waiting_for_receiver'
  | 'transferring'
  | 'receiving'
  | 'complete'
  | 'error'
  // Manual exchange states
  | 'generating_offer'
  | 'showing_offer'
  | 'waiting_for_answer'
  | 'waiting_for_offer'
  | 'generating_answer'
  | 'showing_answer'

// File metadata
export interface FileMetadata {
  fileName: string
  fileSize: number
  mimeType: string
}

export interface TransferState {
  status: TransferStatus
  message?: string
  progress?: {
    current: number  // bytes transferred
    total: number    // total bytes
  }
  contentType?: ContentType
  fileMetadata?: FileMetadata
  useWebRTC?: boolean
  currentRelays?: string[] // Current relay URLs being used (for signaling)
}

// PIN Exchange payload (encrypted in the event)
export interface PinExchangePayload {
  contentType: ContentType
  transferId: string
  senderPubkey: string
  totalChunks: number
  // Sender's preferred relays for signaling
  relays?: string[]
  // tmpfiles.org download URL for encrypted data
  tmpfilesUrl?: string
  // For file
  fileName?: string
  fileSize?: number
  mimeType?: string
}

// ACK payload
export interface AckData {
  transferId: string
  seq: number // -1 for final completion ACK, 0 for ready, N for chunk N ACK (1-based)
}

// Chunk notification payload (sender -> receiver when cloud fallback)
export interface ChunkNotifyPayload {
  transferId: string
  chunkIndex: number    // 0-based chunk index
  totalChunks: number   // Total number of chunks
  chunkUrl: string      // Download URL for this chunk
  chunkSize: number     // Size of this chunk in bytes
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
export interface ReceivedFile {
  contentType: 'file'
  data: Uint8Array
  fileName: string
  fileSize: number
  mimeType: string
}

export type ReceivedContent = ReceivedFile

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

// Signaling method for P2P connection
export type SignalingMethod = 'nostr' | 'peerjs' | 'manual'
