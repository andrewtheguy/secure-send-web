import QRWorker from '@/workers/qrGenerator.worker?worker'

// Eager-load worker on module import for offline support
const worker = new QRWorker()
let requestId = 0
const pending = new Map<number, { resolve: (url: string) => void; reject: (error: Error) => void }>()

// Set up message handler at module scope
worker.onmessage = (e: MessageEvent) => {
  const { id, svg, type, error } = e.data
  const resolver = pending.get(id)
  if (resolver) {
    if (type === 'success') {
      resolver.resolve(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    } else {
      resolver.reject(new Error(error || 'QR generation failed'))
    }
    pending.delete(id)
  }
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
    const id = requestId++
    pending.set(id, { resolve, reject })
    // Create a copy of the buffer to transfer
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    worker.postMessage({ type: 'generate', id, binaryBuffer: buffer, options: options || {} }, [buffer])
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
    const id = requestId++
    pending.set(id, { resolve, reject })
    worker.postMessage({ type: 'generate', id, text, options: options || {} })
  })
}
