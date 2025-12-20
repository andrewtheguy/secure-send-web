export interface ReceivedFile {
  contentType: 'file'
  data: Uint8Array
  fileName: string
  fileSize: number
  mimeType: string
}

export type ReceivedContent = ReceivedFile

export interface PinKeyMaterial {
  key: CryptoKey
  hint: string
}
