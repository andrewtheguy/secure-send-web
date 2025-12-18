import QRWorker from '@/workers/qrGenerator.worker?worker'

let worker: Worker | null = null
let requestId = 0
const pending = new Map<number, { resolve: (url: string) => void; reject: (error: Error) => void }>()

/**
 * Generate a QR code image from binary data
 * Returns a blob URL (PNG image)
 * Uses 8-bit byte mode for binary data
 */
export async function generateBinaryQRCode(
  data: Uint8Array,
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
): Promise<string> {
  if (!worker) {
    worker = new QRWorker()
    worker.onmessage = (e: MessageEvent) => {
      const { id, buffer, type, error } = e.data
      const resolver = pending.get(id)
      if (resolver) {
        if (type === 'success') {
          const blob = new Blob([buffer], { type: 'image/png' })
          resolver.resolve(URL.createObjectURL(blob))
        } else {
          resolver.reject(new Error(error || 'QR generation failed'))
        }
        pending.delete(id)
      }
    }
  }

  return new Promise((resolve, reject) => {
    const id = requestId++
    pending.set(id, { resolve, reject })
    // Create a copy of the buffer to transfer
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    worker!.postMessage(
      { type: 'generate', id, binaryBuffer: buffer, options: options || {} },
      [buffer]
    )
  })
}

/**
 * Clean up the QR worker when no longer needed
 */
export function terminateQRWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
  pending.clear()
}
