/**
 * WebRTC ICE Server Configuration
 *
 * Provides reliable ICE server configuration with multiple STUN fallbacks
 * and optional TURN server support for NAT traversal.
 *
 * TURN credentials should be set via environment variables:
 * - VITE_TURN_URL: TURN server URL (e.g., "turn:turn.example.com:3478")
 * - VITE_TURN_USERNAME: TURN username
 * - VITE_TURN_CREDENTIAL: TURN credential/password
 *
 * For TURN servers with time-limited credentials (TURN REST API),
 * you may need to fetch fresh credentials from your backend.
 */

/**
 * Public STUN servers for NAT traversal.
 * Multiple servers provide redundancy if one is unavailable.
 */
const STUN_SERVERS: RTCIceServer[] = [
  // Google STUN servers (highly reliable)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Cloudflare STUN
  { urls: 'stun:stun.cloudflare.com:3478' },
]

/**
 * Get TURN server configuration from environment variables.
 * Returns undefined if TURN is not configured.
 */
function getTurnServer(): RTCIceServer | undefined {
  const turnUrl = import.meta.env.VITE_TURN_URL
  const turnUsername = import.meta.env.VITE_TURN_USERNAME
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL

  if (!turnUrl) {
    return undefined
  }

  // TURN requires credentials
  if (!turnUsername || !turnCredential) {
    console.warn(
      'TURN server URL provided but credentials missing. ' +
      'Set VITE_TURN_USERNAME and VITE_TURN_CREDENTIAL.'
    )
    return undefined
  }

  return {
    urls: turnUrl,
    username: turnUsername,
    credential: turnCredential,
  }
}

/**
 * Get the complete ICE server configuration.
 * Includes multiple STUN servers and optional TURN server.
 */
export function getIceServers(): RTCIceServer[] {
  const servers = [...STUN_SERVERS]

  const turnServer = getTurnServer()
  if (turnServer) {
    // TURN servers should be listed after STUN for proper fallback order
    servers.push(turnServer)
  }

  return servers
}

/**
 * Get complete RTCConfiguration with ICE servers.
 * Use this when creating a new RTCPeerConnection.
 */
export function getWebRTCConfig(): RTCConfiguration {
  return {
    iceServers: getIceServers(),
    // Use all available candidates for best connectivity
    iceCandidatePoolSize: 10,
  }
}

/**
 * Check if TURN server is configured.
 * Useful for UI feedback about relay availability.
 */
export function isTurnConfigured(): boolean {
  return getTurnServer() !== undefined
}
