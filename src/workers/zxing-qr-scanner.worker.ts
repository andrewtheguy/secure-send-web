import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'

interface ScanMessage {
  type: 'scan'
  imageData: ImageData
  options?: ReaderOptions
  binary?: boolean // If true, return raw bytes; if false, return text
}

interface ScanResult {
  type: 'result'
  data: (string | Uint8Array)[] | null
  error?: string
}

self.onmessage = async (e: MessageEvent<ScanMessage>) => {
  if (e.data.type === 'scan') {
    try {
      const { imageData, options, binary = false } = e.data

      const readerOptions: ReaderOptions = {
        // Optimized for QR-only scanning
        formats: ['QRCode'],
        // Speed optimization: don't try harder, expect well-formed QR codes
        tryHarder: false,
        // Disable rotation detection: camera provides aligned QR codes
        tryRotate: false,
        // Disable invert detection: sender won't send inverted QR codes
        tryInvert: false,
        // Use FixedThreshold for monochrome QR codes (faster than LocalAverage)
        binarizer: 'FixedThreshold',
        // Only expect one QR code per frame
        maxNumberOfSymbols: 1,
        ...options,
      }

      const results = await readBarcodes(imageData, readerOptions)

      const detectedData = results.length > 0
        ? results.map((r) => {
            // If binary mode is enabled, return raw bytes; otherwise return text
            if (binary) {
              return r.bytes
            } else {
              return r.text
            }
          })
        : null

      const result: ScanResult = {
        type: 'result',
        data: detectedData,
      }
      self.postMessage(result)
    } catch (error) {
      const result: ScanResult = {
        type: 'result',
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      self.postMessage(result)
    }
  }
}

export {}
