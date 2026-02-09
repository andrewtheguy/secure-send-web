import QRWorker from '@/workers/qrGenerator.worker?worker'

// Eager-load worker on module import for offline support
const worker = new QRWorker()
let requestId = 0
const REQUEST_TIMEOUT_MS = 15000

interface PendingRequest {
  resolve: (url: string) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const pending = new Map<number, PendingRequest>()

function takePendingRequest(id: number): PendingRequest | null {
  const request = pending.get(id)
  if (!request) {
    return null
  }
  clearTimeout(request.timeoutId)
  pending.delete(id)
  return request
}

function rejectAllPendingRequests(reason: string): void {
  for (const [id, request] of pending) {
    clearTimeout(request.timeoutId)
    request.reject(new Error(reason))
    pending.delete(id)
  }
}

function registerPendingRequest(
  resolve: (url: string) => void,
  reject: (error: Error) => void
): number {
  const id = requestId++
  const timeoutId = setTimeout(() => {
    const request = takePendingRequest(id)
    if (!request) {
      return
    }
    request.reject(new Error(`QR generation timed out after ${REQUEST_TIMEOUT_MS}ms`))
  }, REQUEST_TIMEOUT_MS)
  pending.set(id, { resolve, reject, timeoutId })
  return id
}

// Set up message handler at module scope
worker.onmessage = (e: MessageEvent) => {
  const data = e.data as {
    id?: unknown
    svg?: unknown
    type?: unknown
    error?: unknown
  }

  if (typeof data.id !== 'number') {
    return
  }

  const request = takePendingRequest(data.id)
  if (!request) {
    return
  }

  if (data.type === 'success' && typeof data.svg === 'string') {
    request.resolve(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`)
  } else {
    const errorMessage =
      typeof data.error === 'string' && data.error.length > 0
        ? data.error
        : 'QR generation failed'
    request.reject(new Error(errorMessage))
  }
}

worker.onerror = (event: ErrorEvent) => {
  const suffix = event.message ? `: ${event.message}` : ''
  rejectAllPendingRequests(`QR worker error${suffix}`)
}

worker.onmessageerror = () => {
  rejectAllPendingRequests('QR worker message error')
}

/**
 * Generate a QR code image from binary data
 * Returns a data URI (SVG image)
 * Uses 8-bit byte mode for binary data
 */
export function generateBinaryQRCode(
  data: Uint8Array,
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = registerPendingRequest(resolve, reject)
    // Create a copy of the buffer to transfer
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    try {
      worker.postMessage({ type: 'generate', id, binaryBuffer: buffer, options: options || {} }, [buffer])
    } catch (error) {
      const request = takePendingRequest(id)
      if (!request) {
        return
      }
      request.reject(
        error instanceof Error ? error : new Error('Failed to post QR generation request')
      )
    }
  })
}

/**
 * Generate a QR code image from text data
 * Returns a data URI (SVG image)
 * Uses text mode for smaller payloads like URLs
 */
export function generateTextQRCode(
  text: string,
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = registerPendingRequest(resolve, reject)
    try {
      worker.postMessage({ type: 'generate', id, text, options: options || {} })
    } catch (error) {
      const request = takePendingRequest(id)
      if (!request) {
        return
      }
      request.reject(
        error instanceof Error ? error : new Error('Failed to post QR generation request')
      )
    }
  })
}
