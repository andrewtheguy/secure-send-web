import { zipSync } from 'fflate'

/**
 * Check if folder selection is supported by the browser
 */
export const supportsFolderSelection =
  typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype

/**
 * Read files and compress to ZIP
 * Works with both folder selection (webkitdirectory) and multi-file selection (multiple)
 * @param files - FileList from input
 * @param archiveName - Name for the ZIP file (without .zip extension)
 * @param onProgress - Optional progress callback (0-100)
 * @returns ZIP file as File object
 */
export async function compressFilesToZip(
  files: FileList,
  archiveName: string,
  onProgress?: (progress: number) => void
): Promise<File> {
  const fileData: Record<string, Uint8Array> = {}
  const total = files.length

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    // webkitRelativePath is set for folder selection, empty for multi-file
    const path = file.webkitRelativePath || file.name
    const buffer = await file.arrayBuffer()
    fileData[path] = new Uint8Array(buffer)

    if (onProgress) {
      onProgress(Math.round(((i + 1) / total) * 50)) // 0-50% for reading
    }
  }

  // Compress to ZIP
  if (onProgress) onProgress(60)
  const zipped = zipSync(fileData)
  if (onProgress) onProgress(100)

  // Create File object
  const zipBlob = new Blob([zipped as BlobPart], { type: 'application/zip' })
  return new File([zipBlob], `${archiveName}.zip`, { type: 'application/zip' })
}

/**
 * Extract folder name from FileList (for folder selection)
 */
export function getFolderName(files: FileList): string {
  if (files.length === 0) return 'archive'
  // webkitRelativePath is "folderName/subfolder/file.txt"
  const firstPath = files[0].webkitRelativePath
  if (firstPath) {
    return firstPath.split('/')[0]
  }
  return 'archive'
}

/**
 * Calculate total size of all files
 */
export function getTotalSize(files: FileList): number {
  let total = 0
  for (let i = 0; i < files.length; i++) {
    total += files[i].size
  }
  return total
}
