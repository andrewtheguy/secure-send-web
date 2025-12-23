/**
 * Cloud storage with redundancy for encrypted file upload/download
 * Supports multiple upload servers and CORS proxies with automatic failover
 */

// Max size per cloud chunk (10MB) - larger files are split into multiple chunks
export const MAX_CLOUD_CHUNK_SIZE = 10 * 1024 * 1024 // 10MB per chunk

// Test URLs for CORS proxy validation (stable, small content) with fallback
const CORS_TEST_URLS = [
  'https://httpbingo.org/base64/Y29yc19pc193b3JraW5n',
  'https://httpbin.org/base64/Y29yc19pc193b3JraW5n',
  'https://postman-echo.com/get?test=cors_is_working',
]
const CORS_TEST_EXPECTED = 'cors_is_working'

// POST test URL for discovering CORS proxies that support POST
const CORS_POST_TEST_URL = 'https://postman-echo.com/post'

// =============================================================================
// Upload Server Configuration
// =============================================================================

interface UploadServer {
  name: string
  url: string
  formField: string
  extraFields?: Record<string, string> // additional form fields
  parseResponse: (text: string) => string // returns download URL
  corsDownload?: boolean // if true, downloads support CORS directly (no proxy needed)
  needsCorsProxy?: boolean // if true, upload needs to go through a CORS proxy
}

const UPLOAD_SERVERS: UploadServer[] = [
  {
    name: 'tmpfiles.org',
    url: 'https://tmpfiles.org/api/v1/upload',
    formField: 'file',
    parseResponse: (text) => {
      const json = JSON.parse(text)
      if (json.status === 'success' && json.data?.url) {
        // Convert to direct download URL
        return json.data.url.replace('http://tmpfiles.org/', 'https://tmpfiles.org/dl/')
      }
      throw new Error(json.error || 'Upload failed')
    },
  },
  {
    // litterbox doesn't have CORS headers on upload, but downloads work directly
    name: 'litterbox',
    url: 'https://litterbox.catbox.moe/resources/internals/api.php',
    formField: 'fileToUpload',
    extraFields: { reqtype: 'fileupload', time: '1h' },
    parseResponse: (text) => {
      if (text.startsWith('https://')) {
        return text.trim()
      }
      throw new Error(text || 'Upload failed')
    },
    corsDownload: true,
    needsCorsProxy: true,
  },
  {
    name: 'uguu.se',
    url: 'https://uguu.se/upload',
    formField: 'files[]',
    parseResponse: (text) => {
      const json = JSON.parse(text)
      if (json.success && json.files?.[0]?.url) {
        return json.files[0].url
      }
      throw new Error('Upload failed')
    },
    needsCorsProxy: true,
  },
  {
    name: 'x0.at',
    url: 'https://x0.at',
    formField: 'file',
    parseResponse: (text) => {
      const url = text.trim()
      if (url.startsWith('https://')) {
        return url
      }
      throw new Error(text || 'Upload failed')
    },
    needsCorsProxy: true,
  },
]

// =============================================================================
// CORS Proxy Configuration
// =============================================================================

interface CorsProxy {
  name: string
  buildUrl: (targetUrl: string) => string
  supportsPost: boolean
}

const CORS_PROXIES: CorsProxy[] = [
  {
    name: 'corsproxy.io',
    buildUrl: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    supportsPost: true,
  },
  {
    name: 'leverson83',
    buildUrl: (url) => `https://cors.leverson83.org/${url}`,
    supportsPost: true,
  },
  {
    name: 'codetabs',
    buildUrl: (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
    supportsPost: false,
  },
  {
    name: 'cors-anywhere',
    buildUrl: (url) => `https://cors-anywhere.com/${url}`,
    supportsPost: false,
  },
  {
    name: 'allorigins',
    buildUrl: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    supportsPost: false,
  },
]

// =============================================================================
// Cached Working Services
// =============================================================================

let cachedProxy: CorsProxy | null = null
let cachedServer: UploadServer | null = null

/**
 * Reset cached services (useful for testing or forcing re-discovery)
 */
export function resetCachedServices(): void {
  cachedProxy = null
  cachedServer = null
}

// =============================================================================
// Debug/Testing Functions
// =============================================================================

interface ServiceTestResult {
  name: string
  status: 'ok' | 'failed'
  latency?: number
  error?: string
  supportsPost?: boolean
}

interface ConfigMismatch {
  type: 'corsProxy' | 'uploadServer'
  name: string
  field: string
  hardcodedValue: unknown
  testedValue: unknown
  recommendation: string
}

interface TestAllServicesResult {
  corsProxies: ServiceTestResult[]
  uploadServers: ServiceTestResult[]
  summary: {
    workingProxies: number
    postProxies: number
    totalProxies: number
    workingServers: number
    totalServers: number
  }
  configMismatches: ConfigMismatch[]
}

/**
 * Test all CORS proxies and upload servers, returning detailed results
 * Call from browser console: window.testCloudServices()
 *
 * Test order:
 * 1. Test CORS proxies POST support first
 * 2. Test CORS proxies GET support
 * 3. Test upload servers without CORS proxy (direct) - discover actual requirements
 * 4. Test upload servers with CORS proxy for those that need it
 * 5. Compare findings with hardcoded config
 * 6. Report any mismatches
 */
export async function testAllServices(): Promise<TestAllServicesResult> {
  console.log('%c Testing Cloud Services...', 'font-size: 14px; font-weight: bold; color: #3b82f6;')
  console.log('')

  const proxyResults: ServiceTestResult[] = []
  const serverResults: ServiceTestResult[] = []
  const configMismatches: ConfigMismatch[] = []

  // Track tested values for config comparison
  const testedProxyPostSupport: Map<string, boolean> = new Map()
  const testedServerNeedsCors: Map<string, boolean> = new Map()

  // ==========================================================================
  // PHASE 1: Test CORS Proxies POST support first
  // ==========================================================================
  console.log('%c Testing CORS Proxies (POST):', 'font-size: 12px; font-weight: bold; color: #8b5cf6;')

  let firstWorkingPostProxy: CorsProxy | null = null

  for (const proxy of CORS_PROXIES) {
    const start = Date.now()
    let postWorks = false

    try {
      const proxyUrl = proxy.buildUrl(CORS_POST_TEST_URL)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)

      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'post_support' }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (response.ok) {
        const json = await response.json()
        if (json.data?.test === 'post_support') {
          postWorks = true
        }
      }
    } catch {
      // POST failed
    }

    const latency = Date.now() - start
    testedProxyPostSupport.set(proxy.name, postWorks)

    if (postWorks) {
      if (!firstWorkingPostProxy) {
        firstWorkingPostProxy = proxy
      }
      console.log(`   %c✓ ${proxy.name}%c - ${latency}ms`, 'color: #22c55e; font-weight: bold;', 'color: #6b7280;')
    } else {
      console.log(`   %c✗ ${proxy.name}%c - POST not supported`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
    }
  }

  // ==========================================================================
  // PHASE 2: Test CORS Proxies GET support
  // ==========================================================================
  console.log('')
  console.log('%c Testing CORS Proxies (GET):', 'font-size: 12px; font-weight: bold; color: #8b5cf6;')

  let firstWorkingGetProxy: CorsProxy | null = null

  for (const proxy of CORS_PROXIES) {
    const start = Date.now()
    let success = false

    for (const testUrl of CORS_TEST_URLS) {
      try {
        const proxyUrl = proxy.buildUrl(testUrl)
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(proxyUrl, { method: 'GET', signal: controller.signal })
        clearTimeout(timeoutId)

        if (response.ok) {
          const text = await response.text()
          if (text.includes(CORS_TEST_EXPECTED)) {
            success = true
            break
          }
        }
      } catch {
        // Try next test URL
      }
    }

    const latency = Date.now() - start
    const postSupported = testedProxyPostSupport.get(proxy.name) ?? false

    if (success) {
      proxyResults.push({ name: proxy.name, status: 'ok', latency, supportsPost: postSupported })
      if (!firstWorkingGetProxy) {
        firstWorkingGetProxy = proxy
      }
      console.log(`   %c✓ ${proxy.name}%c - ${latency}ms`, 'color: #22c55e; font-weight: bold;', 'color: #6b7280;')
    } else {
      proxyResults.push({ name: proxy.name, status: 'failed', error: 'All test URLs failed', supportsPost: postSupported })
      console.log(`   %c✗ ${proxy.name}%c - All test URLs failed`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
    }
  }

  // ==========================================================================
  // PHASE 3: Test Upload Servers - Direct Upload (no CORS proxy)
  // ==========================================================================
  console.log('')
  console.log('%c Testing Upload Servers (Direct - No CORS Proxy):', 'font-size: 12px; font-weight: bold; color: #8b5cf6;')

  const testData = crypto.getRandomValues(new Uint8Array(32))
  const directUploadResults: Map<string, { success: boolean; url?: string; error?: string }> = new Map()

  // Test direct upload for ALL servers to discover actual CORS requirements
  for (const server of UPLOAD_SERVERS) {
    const start = Date.now()

    try {
      // Attempt direct upload (bypassing CORS proxy logic)
      const url = await uploadToUrl(server.url, server, testData, 'test.bin')
      const latency = Date.now() - start

      directUploadResults.set(server.name, { success: true, url })
      testedServerNeedsCors.set(server.name, false) // Direct upload worked!

      console.log(`   %c✓ ${server.name}%c - ${latency}ms (direct upload works!)`, 'color: #22c55e; font-weight: bold;', 'color: #6b7280;')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      directUploadResults.set(server.name, { success: false, error: errorMsg })
      testedServerNeedsCors.set(server.name, true) // Needs CORS proxy

      console.log(`   %c✗ ${server.name}%c - ${errorMsg} (needs CORS proxy)`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
    }
  }

  // ==========================================================================
  // PHASE 4: Test Upload Servers - Via CORS Proxy (end-to-end verification)
  // ==========================================================================
  console.log('')
  console.log('%c Testing Upload Servers (End-to-End Verification):', 'font-size: 12px; font-weight: bold; color: #8b5cf6;')

  if (!firstWorkingPostProxy && !firstWorkingGetProxy) {
    console.log('   %c⚠ Skipped - No working CORS proxy available', 'color: #f59e0b;')
    for (const server of UPLOAD_SERVERS) {
      serverResults.push({ name: server.name, status: 'failed', error: 'No CORS proxy' })
    }
  } else {
    for (const server of UPLOAD_SERVERS) {
      const directResult = directUploadResults.get(server.name)
      const start = Date.now()

      // If direct upload worked, verify download and record success
      if (directResult?.success && directResult.url) {
        try {
          // Verify download (may need proxy for download even if upload is direct)
          let downloadUrl = directResult.url
          const needsProxyForDownload = !server.corsDownload

          if (needsProxyForDownload && firstWorkingGetProxy) {
            downloadUrl = firstWorkingGetProxy.buildUrl(directResult.url)
          }

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 15000)
          const response = await fetch(downloadUrl, { signal: controller.signal })
          clearTimeout(timeoutId)

          if (response.ok) {
            const downloaded = new Uint8Array(await response.arrayBuffer())
            if (downloaded.length === testData.length && downloaded.every((b, i) => b === testData[i])) {
              const latency = Date.now() - start
              serverResults.push({ name: server.name, status: 'ok', latency })
              console.log(`   %c✓ ${server.name}%c - ${latency}ms (direct upload + download verified)`, 'color: #22c55e; font-weight: bold;', 'color: #6b7280;')
              continue
            }
          }

          serverResults.push({ name: server.name, status: 'failed', error: 'Download verification failed' })
          console.log(`   %c✗ ${server.name}%c - Download verification failed`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error'
          serverResults.push({ name: server.name, status: 'failed', error: errorMsg })
          console.log(`   %c✗ ${server.name}%c - ${errorMsg}`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
        }
        continue
      }

      // Direct upload failed, try via CORS proxy
      if (!firstWorkingPostProxy) {
        serverResults.push({ name: server.name, status: 'failed', error: 'No POST CORS proxy available' })
        console.log(`   %c✗ ${server.name}%c - No POST CORS proxy available`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
        continue
      }

      try {
        const proxyUrl = firstWorkingPostProxy.buildUrl(server.url)
        const uploadUrl = await uploadToUrl(proxyUrl, server, testData, 'test.bin')

        // Verify download
        let downloadUrl = uploadUrl
        const needsProxyForDownload = !server.corsDownload

        if (needsProxyForDownload && firstWorkingGetProxy) {
          downloadUrl = firstWorkingGetProxy.buildUrl(uploadUrl)
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 15000)
        const response = await fetch(downloadUrl, { signal: controller.signal })
        clearTimeout(timeoutId)

        if (response.ok) {
          const downloaded = new Uint8Array(await response.arrayBuffer())
          if (downloaded.length === testData.length && downloaded.every((b, i) => b === testData[i])) {
            const latency = Date.now() - start
            serverResults.push({ name: server.name, status: 'ok', latency })
            console.log(`   %c✓ ${server.name}%c - ${latency}ms (via ${firstWorkingPostProxy.name})`, 'color: #22c55e; font-weight: bold;', 'color: #6b7280;')
            continue
          }
        }

        serverResults.push({ name: server.name, status: 'failed', error: 'Download verification failed' })
        console.log(`   %c✗ ${server.name}%c - Download verification failed`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        serverResults.push({ name: server.name, status: 'failed', error: errorMsg })
        console.log(`   %c✗ ${server.name}%c - ${errorMsg}`, 'color: #ef4444; font-weight: bold;', 'color: #6b7280;')
      }
    }
  }

  // ==========================================================================
  // PHASE 5: Compare findings with hardcoded config
  // ==========================================================================

  // Check CORS proxy supportsPost mismatches
  for (const proxy of CORS_PROXIES) {
    const testedPost = testedProxyPostSupport.get(proxy.name)
    if (testedPost !== undefined && testedPost !== proxy.supportsPost) {
      configMismatches.push({
        type: 'corsProxy',
        name: proxy.name,
        field: 'supportsPost',
        hardcodedValue: proxy.supportsPost,
        testedValue: testedPost,
        recommendation: testedPost
          ? `Set supportsPost: true for ${proxy.name}`
          : `Set supportsPost: false for ${proxy.name}`,
      })
    }
  }

  // Check upload server needsCorsProxy mismatches
  for (const server of UPLOAD_SERVERS) {
    const testedNeedsCors = testedServerNeedsCors.get(server.name)
    const hardcodedNeedsCors = server.needsCorsProxy ?? false // defaults to false

    if (testedNeedsCors !== undefined && testedNeedsCors !== hardcodedNeedsCors) {
      configMismatches.push({
        type: 'uploadServer',
        name: server.name,
        field: 'needsCorsProxy',
        hardcodedValue: hardcodedNeedsCors,
        testedValue: testedNeedsCors,
        recommendation: testedNeedsCors
          ? `Add needsCorsProxy: true to ${server.name}`
          : `Remove needsCorsProxy (or set to false) for ${server.name}`,
      })
    }
  }

  // ==========================================================================
  // PHASE 6: Report config mismatches
  // ==========================================================================
  console.log('')
  console.log('%c Config Validation:', 'font-size: 12px; font-weight: bold; color: #8b5cf6;')

  if (configMismatches.length === 0) {
    console.log('   %c✓ All hardcoded config values match test findings', 'color: #22c55e;')
  } else {
    console.log(`   %c⚠ Found ${configMismatches.length} config mismatch(es):`, 'color: #f59e0b;')
    for (const mismatch of configMismatches) {
      console.log(`     - ${mismatch.type} %c"${mismatch.name}"%c: ${mismatch.field}`, 'color: #3b82f6;', 'color: inherit;')
      console.log(`       Hardcoded: %c${mismatch.hardcodedValue}%c, Tested: %c${mismatch.testedValue}`, 'color: #ef4444;', 'color: inherit;', 'color: #22c55e;')
      console.log(`       Recommendation: %c${mismatch.recommendation}`, 'color: #f59e0b;')
    }
  }

  // Summary
  const workingProxies = proxyResults.filter((r) => r.status === 'ok').length
  const postProxies = proxyResults.filter((r) => r.supportsPost === true).length
  const workingServers = serverResults.filter((r) => r.status === 'ok').length

  console.log('')
  console.log('%c Summary:', 'font-size: 12px; font-weight: bold; color: #8b5cf6;')
  console.log(`   CORS Proxies (GET): %c${workingProxies}/${CORS_PROXIES.length} working`, workingProxies > 0 ? 'color: #22c55e;' : 'color: #ef4444;')
  console.log(`   CORS Proxies (POST): %c${postProxies}/${CORS_PROXIES.length} working`, postProxies > 0 ? 'color: #22c55e;' : 'color: #ef4444;')
  console.log(`   Upload Servers: %c${workingServers}/${UPLOAD_SERVERS.length} working`, workingServers > 0 ? 'color: #22c55e;' : 'color: #ef4444;')
  console.log(`   Config Mismatches: %c${configMismatches.length}`, configMismatches.length === 0 ? 'color: #22c55e;' : 'color: #f59e0b;')
  console.log('')

  return {
    corsProxies: proxyResults,
    uploadServers: serverResults,
    summary: {
      workingProxies,
      postProxies,
      totalProxies: CORS_PROXIES.length,
      workingServers,
      totalServers: UPLOAD_SERVERS.length,
    },
    configMismatches,
  }
}

/**
 * Force a specific upload server by name (for debugging)
 * Call from console: setCloudServer('litterbox') or setCloudServer('tmpfiles.org')
 * Pass null to reset to automatic selection
 */
export function setCloudServer(serverName?: string | null): void {
  if (!serverName) {
    cachedServer = null
    console.log('Cloud server reset to automatic')
    return
  }

  const server = UPLOAD_SERVERS.find(
    (s) => s.name.toLowerCase() === serverName.toLowerCase()
  )
  if (server) {
    cachedServer = server
    console.log(`Cloud server set to: ${server.name}`)
  } else {
    console.log(`Unknown server: ${serverName}`)
  }
}

// Expose to window for console access
if (typeof window !== 'undefined') {
  ;(window as unknown as { testCloudServices: typeof testAllServices }).testCloudServices = testAllServices
}

// =============================================================================
// Pre-Testing Functions
// =============================================================================

/**
 * Test CORS proxies against stable URLs to find a working one
 */
async function findWorkingCorsProxy(): Promise<CorsProxy | null> {
  for (const proxy of CORS_PROXIES) {
    console.log(`Testing CORS proxy ${proxy.name}...`)

    for (const testUrl of CORS_TEST_URLS) {
      try {
        const proxyUrl = proxy.buildUrl(testUrl)
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(proxyUrl, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeoutId)

        if (response.ok) {
          const text = await response.text()
          if (text.includes(CORS_TEST_EXPECTED)) {
            console.log(`CORS proxy ${proxy.name} is working`)
            return proxy
          }
        }
      } catch {
        // Try next test URL
      }
    }
    console.warn(`CORS proxy ${proxy.name} failed all test URLs`)
  }
  return null
}

/**
 * Upload to a specific server with a specific URL (internal helper)
 */
function uploadToUrl(
  url: string,
  server: UploadServer,
  data: Uint8Array,
  filename: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const buffer = new ArrayBuffer(data.length)
    new Uint8Array(buffer).set(data)
    const blob = new Blob([buffer], { type: 'application/octet-stream' })
    const formData = new FormData()
    // Add extra fields first (some APIs require them before file)
    if (server.extraFields) {
      for (const [key, value] of Object.entries(server.extraFields)) {
        formData.append(key, value)
      }
    }
    formData.append(server.formField, blob, filename)

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
          const result = server.parseResponse(xhr.responseText)
          resolve(result)
        } catch (err) {
          reject(err)
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

    xhr.open('POST', url)
    xhr.send(formData)
  })
}

/**
 * Upload to a specific server with CORS proxy failover (internal helper)
 */
async function uploadToServer(
  server: UploadServer,
  data: Uint8Array,
  filename: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  // If server doesn't need CORS proxy, upload directly
  if (!server.needsCorsProxy) {
    return uploadToUrl(server.url, server, data, filename, onProgress)
  }

  // Try each CORS proxy that supports POST
  const postProxies = CORS_PROXIES.filter((p) => p.supportsPost)
  const errors: string[] = []

  for (const proxy of postProxies) {
    const proxyUrl = proxy.buildUrl(server.url)
    try {
      console.log(`Trying ${server.name} via ${proxy.name}...`)
      const result = await uploadToUrl(proxyUrl, server, data, filename, onProgress)
      console.log(`Upload to ${server.name} via ${proxy.name} succeeded`)
      return result
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      console.warn(`Upload to ${server.name} via ${proxy.name} failed: ${errMsg}`)
      errors.push(`${proxy.name}: ${errMsg}`)
    }
  }

  throw new Error(`All CORS proxies failed for ${server.name}: ${errors.join(', ')}`)
}

/**
 * Test upload servers by uploading a small file and verifying download
 */
async function findWorkingUploadServer(workingProxy: CorsProxy): Promise<UploadServer | null> {
  const testData = crypto.getRandomValues(new Uint8Array(32))

  for (const server of UPLOAD_SERVERS) {
    try {
      console.log(`Testing upload server ${server.name}...`)

      // Upload small test file
      const uploadUrl = await uploadToServer(server, testData, 'test.bin')
      console.log(`Upload to ${server.name} succeeded, verifying download...`)

      // Verify download works via the working CORS proxy
      const proxyUrl = workingProxy.buildUrl(uploadUrl)
      console.log(`Testing download from ${server.name} via ${workingProxy.name}...`)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

      const response = await fetch(proxyUrl, { signal: controller.signal })
      clearTimeout(timeoutId)
      console.log(`Download test response: ${response.status} ${response.statusText}`)

      if (response.ok) {
        const downloaded = new Uint8Array(await response.arrayBuffer())
        // Verify content matches
        if (
          downloaded.length === testData.length &&
          downloaded.every((b, i) => b === testData[i])
        ) {
          console.log(`Upload server ${server.name} is working`)
          return server
        } else {
          console.warn(`Upload server ${server.name} download verification failed: content mismatch`)
        }
      }
    } catch (err) {
      console.warn(`Upload server ${server.name} failed test:`, err)
    }
  }
  return null
}

/**
 * Get working services (with caching)
 */
async function getWorkingServices(): Promise<{ proxy: CorsProxy; server: UploadServer }> {
  if (!cachedProxy) {
    cachedProxy = await findWorkingCorsProxy()
    if (!cachedProxy) {
      throw new Error('No working CORS proxy found')
    }
  }

  if (!cachedServer) {
    cachedServer = await findWorkingUploadServer(cachedProxy)
    if (!cachedServer) {
      throw new Error('No working upload server found')
    }
  }

  return { proxy: cachedProxy, server: cachedServer }
}

// =============================================================================
// Public API
// =============================================================================

export interface CloudUploadResult {
  url: string // Direct download URL
  server: string // Name of server used
}

/**
 * Upload encrypted blob to cloud storage
 *
 * @param data - Encrypted data as Uint8Array
 * @param filename - Optional filename (defaults to 'encrypted.bin')
 * @param onProgress - Optional progress callback (0-100)
 * @returns Direct download URL and server name
 */
export async function uploadToCloud(
  data: Uint8Array,
  filename: string = 'encrypted.bin',
  onProgress?: (progress: number) => void
): Promise<CloudUploadResult> {
  if (data.length > MAX_CLOUD_CHUNK_SIZE) {
    throw new Error(
      `Chunk size (${Math.round(data.length / 1024 / 1024)}MB) exceeds limit (${MAX_CLOUD_CHUNK_SIZE / 1024 / 1024}MB). Use chunked upload for larger files.`
    )
  }

  // Get working services (tests and caches on first use)
  const { server } = await getWorkingServices()

  // Upload using the cached working server
  try {
    console.log(`Uploading to ${server.name}...`)
    const url = await uploadToServer(server, data, filename, onProgress)
    console.log(`Upload succeeded via ${server.name}`)
    return { url, server: server.name }
  } catch {
    // If cached server fails, reset cache and try again
    console.warn(`Cached server ${server.name} failed, retrying with fresh discovery...`)
    resetCachedServices()

    const { server: newServer } = await getWorkingServices()
    const url = await uploadToServer(newServer, data, filename, onProgress)
    console.log(`Upload succeeded via ${newServer.name}`)
    return { url, server: newServer.name }
  }
}

// URLs from these domains support CORS directly (no proxy needed)
const CORS_ENABLED_DOMAINS = ['litter.catbox.moe']

/**
 * Check if a URL supports CORS directly (no proxy needed)
 */
function isCorsEnabledUrl(url: string): boolean {
  try {
    const urlObj = new URL(url)
    return CORS_ENABLED_DOMAINS.some((domain) => urlObj.hostname === domain)
  } catch {
    return false
  }
}

/**
 * Download file directly (for CORS-enabled URLs)
 */
function downloadDirect(
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

/**
 * Download file from cloud storage (direct or via CORS proxy)
 *
 * @param url - Direct download URL
 * @param onProgress - Optional progress callback (loaded bytes, total bytes)
 * @returns Downloaded data as Uint8Array
 */
export async function downloadFromCloud(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<Uint8Array> {
  // Check if URL supports CORS directly
  if (isCorsEnabledUrl(url)) {
    console.log(`Downloading directly (CORS-enabled)...`)
    try {
      const data = await downloadDirect(url, onProgress)
      console.log(`Direct download succeeded`)
      return data
    } catch (err) {
      console.warn(`Direct download failed, falling back to proxy:`, err)
      // Fall through to proxy-based download
    }
  }

  // Get working services (tests and caches on first use)
  const { proxy } = await getWorkingServices()

  const downloadViaProxy = (proxyToUse: CorsProxy): Promise<Uint8Array> => {
    return new Promise((resolve, reject) => {
      const proxyUrl = proxyToUse.buildUrl(url)
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

      xhr.open('GET', proxyUrl)
      xhr.send()
    })
  }

  // Try cached proxy first
  try {
    console.log(`Downloading via ${proxy.name}...`)
    const data = await downloadViaProxy(proxy)
    console.log(`Download succeeded via ${proxy.name}`)
    return data
  } catch {
    // If cached proxy fails, try all proxies
    console.warn(`Cached proxy ${proxy.name} failed, trying alternatives...`)

    for (const altProxy of CORS_PROXIES) {
      if (altProxy.name === proxy.name) continue // Skip already tried

      try {
        console.log(`Trying download via ${altProxy.name}...`)
        const data = await downloadViaProxy(altProxy)
        console.log(`Download succeeded via ${altProxy.name}`)
        // Update cache
        cachedProxy = altProxy
        return data
      } catch (altErr) {
        console.warn(`Download via ${altProxy.name} failed:`, altErr)
      }
    }

    throw new Error('All CORS proxies failed')
  }
}

// =============================================================================
// Chunked Upload/Download Helpers
// =============================================================================

/**
 * Split data into chunks for upload
 * @param data - Data to split
 * @param chunkSize - Size of each chunk (defaults to MAX_CLOUD_CHUNK_SIZE)
 * @returns Array of chunks
 */
export function splitIntoChunks(
  data: Uint8Array,
  chunkSize: number = MAX_CLOUD_CHUNK_SIZE
): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, Math.min(i + chunkSize, data.length)))
  }
  return chunks
}

/**
 * Combine chunks back into single array
 * @param chunks - Array of chunks to combine
 * @returns Combined data
 */
export function combineChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
