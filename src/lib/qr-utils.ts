import QRCode from 'qrcode'

/**
 * Generate a QR code image from text data (base45 encoded payload)
 * Returns a data URL (PNG image)
 * Uses alphanumeric mode for optimal QR size with base45 data
 */
export async function generateQRCode(data: string, options?: {
  width?: number
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
}): Promise<string> {
  // Use segments API to force alphanumeric mode for base45 data
  return QRCode.toDataURL([{ data, mode: 'alphanumeric' }], {
    errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
    width: options?.width || 256,
    margin: 2,
  })
}
