/**
 * tmpfiles.org API helper for encrypted file upload/download
 * https://tmpfiles.org/api
 *
 * - Max file size: 100MB
 * - File retention: 60 minutes
 */

const TMPFILES_UPLOAD_URL = 'https://tmpfiles.org/api/v1/upload'

export const MAX_TMPFILES_SIZE = 100 * 1024 * 1024 // 100MB

interface TmpfilesApiResponse {
  status: 'success' | 'error'
  data?: {
    url: string
  }
  error?: string
}

export interface TmpfilesUploadResult {
  url: string  // Direct download URL (already converted)
}

/**
 * Convert tmpfiles.org response URL to direct download URL
 * http://tmpfiles.org/15788663/file.json → https://tmpfiles.org/dl/15788663/file.json
 */
function convertToDirectUrl(originalUrl: string): string {
  return originalUrl.replace('http://tmpfiles.org/', 'https://tmpfiles.org/dl/')
}

/**
 * Upload encrypted blob to tmpfiles.org
 *
 * @param data - Encrypted data as Uint8Array
 * @param filename - Optional filename (defaults to 'encrypted.bin')
 * @param onProgress - Optional progress callback (0-100)
 * @returns Direct download URL
 */
export async function uploadToTmpfiles(
  data: Uint8Array,
  filename: string = 'encrypted.bin',
  onProgress?: (progress: number) => void
): Promise<TmpfilesUploadResult> {
  if (data.length > MAX_TMPFILES_SIZE) {
    throw new Error(`File size (${Math.round(data.length / 1024 / 1024)}MB) exceeds tmpfiles.org limit (100MB)`)
  }

  // Copy to a new ArrayBuffer to satisfy TypeScript
  const buffer = new ArrayBuffer(data.length)
  new Uint8Array(buffer).set(data)
  const blob = new Blob([buffer], { type: 'application/octet-stream' })
  const formData = new FormData()
  formData.append('file', blob, filename)

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100)
        onProgress(progress)
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response: TmpfilesApiResponse = JSON.parse(xhr.responseText)
          if (response.status === 'success' && response.data?.url) {
            const directUrl = convertToDirectUrl(response.data.url)
            resolve({ url: directUrl })
          } else {
            reject(new Error(response.error || 'Upload failed: Invalid response'))
          }
        } catch (err) {
          reject(new Error('Upload failed: Could not parse response'))
        }
      } else {
        reject(new Error(`Upload failed: HTTP ${xhr.status}`))
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed: Network error'))
    })

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'))
    })

    xhr.open('POST', TMPFILES_UPLOAD_URL)
    xhr.send(formData)
  })
}

/**
 * Download file from tmpfiles.org
 *
 * @param url - Direct download URL (https://tmpfiles.org/dl/...)
 * @param onProgress - Optional progress callback (loaded bytes, total bytes)
 * @returns Downloaded data as Uint8Array
 */
export async function downloadFromTmpfiles(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.responseType = 'arraybuffer'

    xhr.addEventListener('progress', (event) => {
      if (onProgress) {
        onProgress(event.loaded, event.lengthComputable ? event.total : 0)
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = new Uint8Array(xhr.response)
        resolve(data)
      } else {
        reject(new Error(`Download failed: HTTP ${xhr.status}`))
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Download failed: Network error'))
    })

    xhr.addEventListener('abort', () => {
      reject(new Error('Download cancelled'))
    })

    xhr.open('GET', url)
    xhr.send()
  })
}
