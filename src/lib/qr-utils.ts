import { writeBarcode } from 'zxing-wasm/full'

/**
 * Generate a QR code image from text data (base64 encoded payload)
 * Returns a data URL (PNG image)
 */
export async function generateQRCode(data: string, options?: {
  width?: number
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
}): Promise<string> {
  // Base64 text is just ASCII, use TextEncoder
  const bytes = new TextEncoder().encode(data)

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
