import initRxingWasm, { read_qr_codes_rgba } from '@andrewtheguy/rxing-wasm'

export type Binarizer = 'hybrid' | 'global'

export interface RxingReaderOptions {
  tryHarder?: boolean
  tryInvert?: boolean
  binarizer?: Binarizer
  binarizerFallback?: boolean
}

// Hardcoded to 1: the live scanner consumes `results[0]` and the underlying
// multi-decode loop short-circuits on the first valid detection.
//
// Possible future direction (still under consideration): when scanning the
// sender's multi-QR grid for chunked offers (see multi-qr-display.tsx +
// chunk-utils.ts), bumping this would let one camera frame contribute
// multiple chunks at once instead of one-per-frame. Unclear whether it
// actually helps — those QR codes are already dense, and people might end
// up needing to scan one by one anyways. Would also require the scanner
// worker + useQRScanner consumer to handle `Uint8Array[]` with length > 1.
const MAX_NUMBER_OF_SYMBOLS = 1

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

export async function ensureRxingWasmInit(): Promise<void> {
  if (wasmInitialized) return

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      await initRxingWasm()
      wasmInitialized = true
    })().catch((error) => {
      wasmInitPromise = null
      throw error
    })
  }

  await wasmInitPromise
}

function toUint8Array(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export async function readQrCodesFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: RxingReaderOptions = {}
): Promise<Uint8Array[]> {
  await ensureRxingWasmInit()

  const {
    tryHarder = false,
    tryInvert = false,
    binarizer = 'hybrid',
    binarizerFallback = false,
  } = options

  const results = read_qr_codes_rgba(
    toUint8Array(rgba),
    width,
    height,
    tryHarder,
    tryInvert,
    binarizer === 'hybrid',
    binarizerFallback,
    MAX_NUMBER_OF_SYMBOLS
  ) as Uint8Array[]

  return results
}

export async function readQrCodesFromImageData(
  imageData: ImageData,
  options: RxingReaderOptions = {}
): Promise<Uint8Array[]> {
  return readQrCodesFromRgba(imageData.data, imageData.width, imageData.height, options)
}
