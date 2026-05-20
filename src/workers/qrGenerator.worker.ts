// QR Generation Worker
// Offloads expensive QR encoding from the main thread.

import { generateFastQrSvgString } from '@/lib/wasm/fastQrWasm'

interface WorkerRequest {
  type: 'generate'
  id: number
  binaryBuffer: ArrayBuffer
  forceByteMode: boolean
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { type, id, binaryBuffer, forceByteMode, options } = e.data

  if (type !== 'generate') return

  try {
    const dimension = options?.width ?? 400

    const svg = await generateFastQrSvgString(new Uint8Array(binaryBuffer), {
      margin: 0,
      errorCorrectionLevel: options?.errorCorrectionLevel ?? 'M',
      forceByteMode,
      svgWidth: dimension,
      svgHeight: dimension,
    })

    self.postMessage({ type: 'success', id, svg })
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export {}
