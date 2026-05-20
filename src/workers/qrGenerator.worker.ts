// QR Generation Worker
// Offloads expensive QR encoding from the main thread.

import { generateFastQrSvgString } from '@/lib/wasm/fastQrWasm'

interface WorkerRequest {
  type: 'generate'
  id: number
  binaryBuffer?: ArrayBuffer
  text?: string
  options?: {
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { type, id, binaryBuffer, text, options } = e.data

  if (type !== 'generate') return

  try {
    let payload: Uint8Array
    let forceByteMode: boolean

    if (typeof text === 'string') {
      payload = new TextEncoder().encode(text)
      forceByteMode = false
    } else if (binaryBuffer instanceof ArrayBuffer) {
      payload = new Uint8Array(binaryBuffer)
      forceByteMode = true
    } else {
      throw new Error('Missing QR payload')
    }

    const dimension = options?.width ?? 400

    const svg = await generateFastQrSvgString(payload, {
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
