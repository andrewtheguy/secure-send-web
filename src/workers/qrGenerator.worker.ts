// QR Generation Worker
// Offloads expensive writeBarcode calls from main thread

import { writeBarcode, prepareZXingModule } from 'zxing-wasm/full'

// Configure zxing-wasm to use local WASM file (cached by service worker for offline support)
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => {
      if (path.endsWith('.wasm')) {
        return `/${path}`
      }
      return prefix + path
    },
  },
  fireImmediately: true,
})

// Worker-specific postMessage with transferable objects support
const workerSelf = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

// Listen for messages from main thread
workerSelf.onmessage = async (e: MessageEvent) => {
  const { type, id, binaryBuffer, options } = e.data

  if (type === 'generate') {
    try {
      if (!(binaryBuffer instanceof ArrayBuffer)) {
        throw new Error('Missing QR payload')
      }

      const binaryData = new Uint8Array(binaryBuffer)

      const result = await writeBarcode(binaryData, {
        format: 'QRCode',
        ecLevel: (options.errorCorrectionLevel as 'L' | 'M' | 'Q' | 'H') || 'M',
        sizeHint: options.width || 400,
        withQuietZones: true
      })

      if (result.error) {
        throw new Error(result.error)
      }

      const blob = result.image as Blob
      const buffer = await blob.arrayBuffer()

      workerSelf.postMessage(
        { type: 'success', id, buffer, mimeType: blob.type || 'image/png' },
        [buffer]
      )
    } catch (error) {
      workerSelf.postMessage({ type: 'error', id, error: (error as Error).message })
    }
  }
}

export {}
