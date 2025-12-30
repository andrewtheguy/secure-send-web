/**
 * Read a File object as Uint8Array
 */
export async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer
      resolve(new Uint8Array(buffer))
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * Trigger a file download in the browser
 */
export function downloadFile(data: Uint8Array, fileName: string, mimeType: string): void {
  // Blob constructor accepts Uint8Array directly and respects the view's byte range
  const blob = new Blob([data as BlobPart], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Trigger a text file download in the browser
 */
export function downloadTextFile(content: string, fileName: string, mimeType: string): void {
  const bytes = new TextEncoder().encode(content)
  downloadFile(bytes, fileName, mimeType)
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  // Guard against zero, negative, or non-finite input
  if (bytes <= 0 || !Number.isFinite(bytes)) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1
  )

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/**
 * Get a user-friendly MIME type description
 */
export function getMimeTypeDescription(mimeType: string): string {
  const descriptions: Record<string, string> = {
    'application/pdf': 'PDF Document',
    'application/zip': 'ZIP Archive',
    'application/json': 'JSON File',
    'text/plain': 'Text File',
    'text/html': 'HTML File',
    'text/css': 'CSS File',
    'text/javascript': 'JavaScript File',
    'image/jpeg': 'JPEG Image',
    'image/png': 'PNG Image',
    'image/gif': 'GIF Image',
    'image/webp': 'WebP Image',
    'image/svg+xml': 'SVG Image',
    'audio/mpeg': 'MP3 Audio',
    'audio/wav': 'WAV Audio',
    'video/mp4': 'MP4 Video',
    'video/webm': 'WebM Video',
  }
  return descriptions[mimeType] || mimeType || 'Unknown'
}
