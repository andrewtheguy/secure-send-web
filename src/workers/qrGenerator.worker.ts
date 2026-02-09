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

// Listen for messages from main thread
self.onmessage = async (e: MessageEvent) => {
  const { type, id, binaryBuffer, text, options } = e.data

  if (type === 'generate') {
    try {
      let payload: Uint8Array | string
      if (typeof text === 'string') {
        payload = text
      } else if (binaryBuffer instanceof ArrayBuffer) {
        payload = new Uint8Array(binaryBuffer)
      } else {
        throw new Error('Missing QR payload')
      }

      const result = await writeBarcode(payload, {
        format: 'QRCode',
        ecLevel: (options.errorCorrectionLevel as 'L' | 'M' | 'Q' | 'H') || 'M',
        sizeHint: options.width || 400,
        withQuietZones: false,
      })

      if (result.error) {
        throw new Error(result.error)
      }

      self.postMessage({ type: 'success', id, svg: result.svg })
    } catch (error) {
      self.postMessage({ type: 'error', id, error: (error as Error).message })
    }
  }
}

export {}
