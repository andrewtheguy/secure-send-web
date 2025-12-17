import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import { computePinHint } from '@/lib/crypto'

// PeerJS cloud server configuration
const PEERJS_HOST = '0.peerjs.com'
const PEERJS_PORT = 443

// Derive peer ID from PIN (must be same for sender and receiver)
export async function derivePeerId(pin: string): Promise<string> {
  const hint = await computePinHint(pin)
  // Prefix with 'ss-' (secure-send) to avoid collisions
  return `ss-${hint}`
}

// Protocol message types
export interface PeerJSMetadata {
  type: 'metadata'
  contentType: 'text' | 'file'
  totalBytes: number
  fileName?: string
  fileSize?: number
  mimeType?: string
  // Encrypted payload for text content (small messages)
  encryptedPayload?: string
}

export interface PeerJSReady {
  type: 'ready'
}

export interface PeerJSChunk {
  type: 'chunk'
  data: ArrayBuffer
}

export interface PeerJSDone {
  type: 'done'
}

export interface PeerJSDoneAck {
  type: 'done_ack'
}

export type PeerJSMessage = PeerJSMetadata | PeerJSReady | PeerJSChunk | PeerJSDone | PeerJSDoneAck

export class PeerJSSignaling {
  private peer: Peer | null = null
  private connection: DataConnection | null = null
  private onOpenCallback: (() => void) | null = null
  private onErrorCallback: ((err: Error) => void) | null = null
  private destroyed = false

  constructor(
    peerId: string,
    onOpen: () => void,
    onError: (err: Error) => void
  ) {
    this.onOpenCallback = onOpen
    this.onErrorCallback = onError

    this.peer = new Peer(peerId, {
      host: PEERJS_HOST,
      port: PEERJS_PORT,
      secure: true,
      debug: 1, // Minimal logging
    })

    this.peer.on('open', (id) => {
      console.log('PeerJS connected with ID:', id)
      if (!this.destroyed && this.onOpenCallback) {
        this.onOpenCallback()
      }
    })

    this.peer.on('error', (err) => {
      console.error('PeerJS error:', err)
      if (!this.destroyed && this.onErrorCallback) {
        this.onErrorCallback(err)
      }
    })

    this.peer.on('disconnected', () => {
      console.log('PeerJS disconnected from signaling server')
    })
  }

  // For sender: wait for receiver to connect
  waitForConnection(
    onConnection: (conn: DataConnection) => void,
    timeoutMs: number = 5 * 60 * 1000 // 5 minutes default
  ): { cancel: () => void } {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let resolved = false

    if (!this.peer) {
      throw new Error('Peer not initialized')
    }

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    timeoutId = setTimeout(() => {
      if (!resolved && !this.destroyed && this.onErrorCallback) {
        resolved = true
        this.onErrorCallback(new Error('Timeout waiting for receiver connection'))
      }
    }, timeoutMs)

    this.peer.on('connection', (conn) => {
      if (this.destroyed || resolved) return
      resolved = true
      cleanup()

      this.connection = conn
      console.log('Receiver connected:', conn.peer)

      conn.on('open', () => {
        console.log('Data connection open with receiver')
        onConnection(conn)
      })

      conn.on('error', (err) => {
        console.error('Data connection error:', err)
        if (!this.destroyed && this.onErrorCallback) {
          this.onErrorCallback(err)
        }
      })
    })

    return {
      cancel: () => {
        resolved = true
        cleanup()
      }
    }
  }

  // For receiver: connect to sender's peer ID
  connectToPeer(peerId: string, timeoutMs: number = 30000): Promise<DataConnection> {
    return new Promise((resolve, reject) => {
      if (!this.peer || this.destroyed) {
        reject(new Error('Peer not initialized or destroyed'))
        return
      }

      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout connecting to sender'))
      }, timeoutMs)

      console.log('Connecting to peer:', peerId)
      const conn = this.peer.connect(peerId, { reliable: true })

      conn.on('open', () => {
        clearTimeout(timeoutId)
        this.connection = conn
        console.log('Connected to sender')
        resolve(conn)
      })

      conn.on('error', (err) => {
        clearTimeout(timeoutId)
        console.error('Connection error:', err)
        reject(err)
      })
    })
  }

  // Send a message over the data connection
  send(message: PeerJSMessage): void {
    if (!this.connection) {
      throw new Error('No active connection')
    }
    this.connection.send(message)
  }

  // Send binary data with backpressure support
  async sendWithBackpressure(
    data: ArrayBuffer,
    bufferThreshold: number = 1024 * 1024 // 1MB default threshold
  ): Promise<void> {
    if (!this.connection) {
      throw new Error('No active connection')
    }

    // PeerJS uses RTCDataChannel internally
    const dc = (this.connection as any).dataChannel as RTCDataChannel | undefined

    if (dc) {
      while (dc.bufferedAmount > bufferThreshold) {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (!dc || dc.readyState !== 'open') {
              resolve()
              return
            }
            if (dc.bufferedAmount <= bufferThreshold) {
              resolve()
            } else {
              setTimeout(check, 10)
            }
          }
          setTimeout(check, 10)
        })
      }
    }

    this.connection.send({ type: 'chunk', data } as PeerJSChunk)
  }

  // Set up message handler
  onMessage(handler: (message: PeerJSMessage) => void): void {
    if (!this.connection) {
      throw new Error('No active connection')
    }

    this.connection.on('data', (data) => {
      handler(data as PeerJSMessage)
    })
  }

  // Check if connected
  isConnected(): boolean {
    return this.connection !== null && this.connection.open
  }

  // Get the peer ID
  getPeerId(): string | null {
    return this.peer?.id || null
  }

  close(): void {
    this.destroyed = true
    if (this.connection) {
      this.connection.close()
      this.connection = null
    }
    if (this.peer) {
      this.peer.destroy()
      this.peer = null
    }
  }
}
