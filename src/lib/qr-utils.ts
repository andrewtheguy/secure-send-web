import { writeBarcode } from 'zxing-wasm/full'

/**
 * Generate a QR code image from Latin-1 encoded data
 * Returns a data URL (PNG image)
 */
export async function generateQRCode(data: string, options?: {
  width?: number
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
}): Promise<string> {
  // Convert Latin-1 string to bytes (preserves byte values 0x00-0xFF)
  const bytes = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    bytes[i] = data.charCodeAt(i) & 0xFF
  }

  const result = await writeBarcode(bytes, {
    format: 'QRCode',
    ecLevel: options?.errorCorrectionLevel || 'M',
    sizeHint: options?.width || 256,
    withQuietZones: true
  })

  if (result.error) {
    throw new Error(result.error)
  }

  // Convert Blob to data URL
  const blob = result.image as Blob
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to convert QR code to data URL'))
    reader.readAsDataURL(blob)
  })
}
