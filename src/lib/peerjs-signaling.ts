import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import { computePinHint } from '@/lib/crypto'

type DataConnectionWithDataChannel = DataConnection & { dataChannel?: RTCDataChannel }

// PeerJS cloud server configuration
const PEERJS_HOST = '0.peerjs.com'
const PEERJS_PORT = 443
const PEERJS_TEST_TIMEOUT_MS = 5000

export interface PeerJSAvailabilityResult {
  available: boolean
  error?: string
}

/**
 * Test PeerJS server availability by attempting to connect.
 * Returns quickly with availability status.
 */
export async function testPeerJSAvailability(
  timeoutMs: number = PEERJS_TEST_TIMEOUT_MS
): Promise<PeerJSAvailabilityResult> {
  return new Promise((resolve) => {
    let peer: Peer | null = null
    let resolved = false

    const cleanup = () => {
      if (peer) {
        try {
          peer.destroy()
        } catch {
          // Ignore cleanup errors
        }
        peer = null
      }
    }

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        resolve({ available: false, error: 'Connection timeout' })
      }
    }, timeoutMs)

    try {
      // Generate a random test peer ID
      const testId = `ss-test-${Math.random().toString(36).substring(2, 10)}`

      peer = new Peer(testId, {
        host: PEERJS_HOST,
        port: PEERJS_PORT,
        secure: true,
        debug: 0, // No logging for test
      })

      peer.on('open', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutId)
          cleanup()
          resolve({ available: true })
        }
      })

      peer.on('error', (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutId)
          cleanup()
          resolve({ available: false, error: err.message || 'Connection failed' })
        }
      })
    } catch (error) {
      if (!resolved) {
        resolved = true
        clearTimeout(timeoutId)
        cleanup()
        resolve({
          available: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }
  })
}

// Derive peer ID from PIN (must be same for sender and receiver)
export async function derivePeerId(pin: string): Promise<string> {
  const hint = await computePinHint(pin)
  // Prefix with 'ss-' (secure-send) to avoid collisions
  return `ss-${hint}`
}

// Protocol message types
export interface PeerJSMetadata {
  type: 'metadata'
  totalBytes: number
  // Milliseconds since epoch when sender created the transfer request.
  // Receiver must enforce TTL before sending "ready".
  createdAt: number
  // Salt used for key derivation (serialized as number[] for JSON transport).
  salt: number[]
  fileName?: string
  fileSize?: number
  mimeType?: string
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

  setOnErrorHandler(handler: (err: Error) => void): () => void {
    const previous = this.onErrorCallback
    this.onErrorCallback = (err) => {
      handler(err)
      previous?.(err)
    }

    return () => {
      this.onErrorCallback = previous
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
    const dc = (this.connection as DataConnectionWithDataChannel).dataChannel

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
