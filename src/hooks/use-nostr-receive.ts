import { useState, useCallback, useRef } from 'react'
import {
  deriveKeyFromPinKey,
  decrypt,
  encrypt,
  parseChunkMessage,
  decryptChunk,
  MAX_MESSAGE_SIZE,
  ENCRYPTION_CHUNK_SIZE,
  CLOUD_CHUNK_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto'
import {
  createNostrClient,
  generateEphemeralKeys,
  parsePinExchangeEvent,
  parseMutualTrustEvent,
  parseMutualTrustHandshakeEvent,
  parseMutualTrustPayloadEvent,
  createAckEvent,
  parseChunkNotifyEvent,
  DEFAULT_RELAYS,
  type TransferState,
  type PinExchangePayload,
  type ChunkNotifyPayload,
  type NostrClient,
  EVENT_KIND_PIN_EXCHANGE,
  EVENT_KIND_DATA_TRANSFER,
  createSignalingEvent,
  parseSignalingEvent,
} from '@/lib/nostr'
import type { PinKeyMaterial, ReceivedContent } from '@/lib/types'
import { downloadFromCloud } from '@/lib/cloud-storage'
import type { Event } from 'nostr-tools'
import { WebRTCConnection } from '@/lib/webrtc'
import { getWebRTCConfig } from '@/lib/webrtc-config'
import {
  getPasskeySessionKeypair,
  verifySessionBinding,
  deriveSessionEncryptionKey,
  type EphemeralSessionKeypair,
} from '@/lib/crypto/passkey'
import {
  deriveAESKeyFromSecretKey,
  publicKeyToFingerprint,
  deriveKeyConfirmationFromSecretKey,
  hashKeyConfirmation,
  verifyPublicKeyCommitment,
  constantTimeEqual,
} from '@/lib/crypto/ecdh'
import { parsePairingKey, getPeerFromParsedPairingKey, getOwnVerificationSecret, getPeerVerificationSecret, computeHandshakeProof, verifyHandshakeProof } from '@/lib/crypto/pairing-key'

export interface ReceiveOptions {
  usePasskey?: boolean
  senderPairingKey?: string // Pairing key for mutual trust mode
  selfTransfer?: boolean // For receiving from self
}

export interface UseNostrReceiveReturn {
  state: TransferState
  receivedContent: ReceivedContent | null
  ownPublicKey: Uint8Array | null
  ownFingerprint: string | null
  receive: (pinMaterial: PinKeyMaterial | ReceiveOptions) => Promise<void>
  cancel: () => void
  reset: () => void
}

export function useNostrReceive(): UseNostrReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' })
  const [receivedContent, setReceivedContent] = useState<ReceivedContent | null>(null)
  const [ownPublicKey, setOwnPublicKey] = useState<Uint8Array | null>(null)
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null)

  const clientRef = useRef<NostrClient | null>(null)
  const cancelledRef = useRef(false)
  const receivingRef = useRef(false)

  const cancel = useCallback(() => {
    cancelledRef.current = true
    receivingRef.current = false
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
    }
    setOwnPublicKey(null)
    setOwnFingerprint(null)
    setState({ status: 'idle' })
  }, [])

  const reset = useCallback(() => {
    cancel()
    setReceivedContent(null)
    setOwnPublicKey(null)
    setOwnFingerprint(null)
  }, [cancel])

  const receive = useCallback(async (arg: PinKeyMaterial | ReceiveOptions) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return
    receivingRef.current = true
    cancelledRef.current = false
    setReceivedContent(null)

    // Determine mode
    const usePasskey = 'usePasskey' in arg && arg.usePasskey === true
    const hasSenderOrSelf =
      ('senderPairingKey' in arg && arg.senderPairingKey) ||
      ('selfTransfer' in arg && arg.selfTransfer)
    const isMutualTrustMode = usePasskey && hasSenderOrSelf
    const pinMaterial = !usePasskey ? (arg as PinKeyMaterial) : null

    // Closure variables for mutual trust mode - keeps sensitive data scoped
    let ownPublicKeyBytes: Uint8Array | null = null
    // SECURITY: sharedSecretKey is a non-extractable CryptoKey - raw secret bytes never exposed to JS
    let sharedSecretKey: CryptoKey | null = null
    let deriveKeyWithSalt: ((salt: Uint8Array) => Promise<CryptoKey>) | null = null
    // PFS: Ephemeral session keypair for Perfect Forward Secrecy
    let receiverEphemeral: EphemeralSessionKeypair | null = null
    let identitySharedSecretKey: CryptoKey | null = null
    // Parsed pairing key for handshake proof computation (cross-user mode)
    let receiverParsedPairingKey: Awaited<ReturnType<typeof parsePairingKey>> | null = null

    try {
      let hint: string
      let key: CryptoKey | null = null
      let expectedSenderFingerprint: string | undefined

      if (isMutualTrustMode) {
        // MUTUAL TRUST MODE: Use passkey mutual trust with sender's public ID
        // NOW WITH PERFECT FORWARD SECRECY via ephemeral session keys
        const opts = arg as ReceiveOptions
        setState({ status: 'connecting', message: 'Authenticate with passkey...' })

        try {
          // Authenticate and get ephemeral session keypair with identity binding
          // SECURITY: Ephemeral private key is NEVER exposed as raw bytes (Web Crypto generateKey)
          const {
            ephemeral,
            identitySharedSecretKey: sharedSecret,
          } = await getPasskeySessionKeypair()

          // Store identity info for display
          setOwnPublicKey(ephemeral.identityPublicKeyBytes)
          setOwnFingerprint(ephemeral.identityFingerprint)

          // Store in closure for event processing
          ownPublicKeyBytes = ephemeral.identityPublicKeyBytes

          // Store for later use (creating ACK with ephemeral key)
          receiverEphemeral = ephemeral
          identitySharedSecretKey = sharedSecret

          // Determine sender public key: use own identity for self-transfer, otherwise parse pairing key
          let senderPublicKeyBytes: Uint8Array
          if (opts.selfTransfer) {
            senderPublicKeyBytes = ephemeral.identityPublicKeyBytes
          } else {
            // Parse pairing key to extract peer info
            // NOTE: With HMAC signatures, we cannot verify the other party's signature here.
            // Trust is established via out-of-band fingerprint verification.
            // SECURITY: The actual peer check happens during handshake event processing
            // (see "SECURITY VERIFICATION 3: Sender's pairing key" below).
            const parsedPairingKey = await parsePairingKey(
              opts.senderPairingKey!,
              ephemeral.identityPublicKeyBytes // Verify we're a party to this pairing key
            )

            // Extract the counterparty (sender) from the pairing key.
            const counterparty = getPeerFromParsedPairingKey(parsedPairingKey, ephemeral.identityPublicKeyBytes)
            senderPublicKeyBytes = counterparty.publicId
          }

          // Calculate expected sender fingerprint for verification
          expectedSenderFingerprint = await publicKeyToFingerprint(senderPublicKeyBytes)

          // Store passkey master key for key derivation and binding verification
          // SECURITY: Raw secret bytes are never exposed to JavaScript
          sharedSecretKey = sharedSecret

          // Hint is our own public ID fingerprint (sender addresses events to us)
          hint = ephemeral.identityFingerprint

          // Store key derivation function in closure for event processing
          const ecdhSharedSecret = sharedSecretKey // Capture for closure
          deriveKeyWithSalt = async (salt: Uint8Array) => {
            return deriveAESKeyFromSecretKey(ecdhSharedSecret, salt)
          }
        } catch (err) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Passkey authentication failed',
          })
          receivingRef.current = false
          return
        }
      } else if (pinMaterial) {
        // PIN mode: use provided material
        if (!pinMaterial.key || !pinMaterial.hint) {
          setState({ status: 'error', message: 'PIN unavailable. Please re-enter.' })
          receivingRef.current = false
          return
        }
        setState({ status: 'connecting', message: 'Deriving encryption key...' })
        hint = pinMaterial.hint
      } else {
        setState({ status: 'error', message: 'No credentials provided' })
        receivingRef.current = false
        return
      }

      if (cancelledRef.current) return

      // Connect to relays
      setState({ status: 'connecting', message: 'Connecting to relays...' })
      const client = createNostrClient([...DEFAULT_RELAYS])
      clientRef.current = client

      if (cancelledRef.current) return

      // Search for exchange event
      setState({ status: 'receiving', message: 'Searching for sender...' })

      // Query for events with matching hint
      const events = await client.query([
        {
          kinds: [EVENT_KIND_PIN_EXCHANGE],
          '#h': [hint],
          limit: 10,
        },
      ])

      if (cancelledRef.current) return

      if (events.length === 0) {
        setState({
          status: 'error',
          message: isMutualTrustMode ? 'No transfer found for this passkey' : 'No transfer found for this PIN',
        })
        return
      }

      // Try to decrypt each event
      let payload: PinExchangePayload | null = null
      let transferId: string | null = null
      let senderPubkey: string | null = null
      let sawExpiredCandidate = false
      let sawNonExpiredCandidate = false
      let selectedCreatedAtSec: number | null = null
      // Security: Store nonce for ready ACK echo
      let eventNonce: string | undefined
      // PFS: Store sender's ephemeral public key and salt for session key derivation
      let senderEphemeralPub: Uint8Array | undefined
      let eventSalt: Uint8Array | undefined
      // Cross-user passkey: flag for handshake flow
      let isHandshakeFlow = false

      // Determine if this is self-transfer or cross-user passkey mode
      const isSelfTransfer = 'selfTransfer' in arg && (arg as ReceiveOptions).selfTransfer
      const isCrossUserPasskey = isMutualTrustMode && !isSelfTransfer

      const sortedEvents = [...events].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))

      for (const event of sortedEvents) {
        // Enforce TTL
        if (!event.created_at) {
          sawExpiredCandidate = true
          continue
        }
        const eventAgeMs = Date.now() - event.created_at * 1000
        if (eventAgeMs > TRANSFER_EXPIRATION_MS) {
          sawExpiredCandidate = true
          continue
        }
        sawNonExpiredCandidate = true

        if (isCrossUserPasskey) {
          // Cross-user passkey mode: look for handshake events
          const parsed = parseMutualTrustHandshakeEvent(event)
          if (!parsed) continue

          // === SECURITY VERIFICATION 1: Sender fingerprint (constant-time) ===
          if (!constantTimeEqual(parsed.senderFingerprint, expectedSenderFingerprint!)) {
            console.log('Sender fingerprint mismatch')
            continue
          }

          // === SECURITY VERIFICATION 2: Receiver public ID commitment ===
          if (!ownPublicKeyBytes) {
            console.error('Own public ID not available for RPKC verification')
            continue
          }
          const rpkcValid = await verifyPublicKeyCommitment(ownPublicKeyBytes, parsed.receiverPkCommitment)
          if (!rpkcValid) {
            console.log('Receiver public ID commitment mismatch - event not addressed to us')
            continue
          }

          // === SECURITY VERIFICATION 3: Sender's pairing key ===
          // CRITICAL: This check ensures decryption won't proceed if counterparty doesn't match.
          // With pairing keys, both parties have the SAME key with both signatures.
          // This proves sender specifically chose to communicate with us.
          const parsedSenderPairingKey = await parsePairingKey(
            parsed.senderPairingKey,
            ownPublicKeyBytes // Verify we're a party to this pairing key
          )
          // Extract the counterparty (sender) from the parsed pairing key
          const senderFromPairingKey = getPeerFromParsedPairingKey(parsedSenderPairingKey, ownPublicKeyBytes)
          // Verify the pairing key's counterparty matches the sender's claimed identity
          // If this check fails, the event is skipped and decryption never happens
          if (senderFromPairingKey.fingerprint !== parsed.senderFingerprint) {
            console.log(`Pairing key counterparty (${senderFromPairingKey.fingerprint}) doesn't match sender (${parsed.senderFingerprint}) - rejecting`)
            continue
          }

          // === SECURITY VERIFICATION 4: Sender's handshake proof ===
          // CRITICAL: This proves the sender controls their passkey, preventing impersonation with stolen pairing keys
          if (!parsed.senderHandshakeProof) {
            console.log('Sender did not provide handshake proof - rejecting')
            continue
          }
          // Get the sender's verification secret from the pairing key
          const senderVs = getPeerVerificationSecret(parsedSenderPairingKey, ownPublicKeyBytes)
          // Decode the nonce from base64 for verification
          let nonceBytes: Uint8Array
          try {
            nonceBytes = Uint8Array.from(atob(parsed.nonce), c => c.charCodeAt(0))
          } catch {
            console.warn('Malformed nonce base64 - skipping event')
            continue
          }
          // Verify the sender's proof: HMAC(sender_vs, sender_epk || nonce || receiver_fingerprint)
          const ownFingerprint = await publicKeyToFingerprint(ownPublicKeyBytes)
          const senderProofValid = await verifyHandshakeProof(
            senderVs,
            parsed.senderHandshakeProof,
            parsed.senderEphemeralPub,
            nonceBytes,
            ownFingerprint
          )
          if (!senderProofValid) {
            console.log('Invalid sender handshake proof - sender does not control their passkey')
            continue
          }

          // Store parsed pairing key for computing receiver's handshake proof in ACK
          receiverParsedPairingKey = parsedSenderPairingKey

          // NOTE: For cross-user passkey mode, we CANNOT verify session binding because:
          // - Session binding is created using the sender's passkey master key
          // - We don't have access to sender's master key (different passkeys = different PRF outputs)
          // Security relies on:
          // 1. Fingerprint verification (above) - ensures sender identity
          // 2. RPKC verification (above) - ensures event is addressed to us
          // 3. Handshake proof verification (above) - proves sender controls their passkey
          // 4. Ephemeral ECDH - any MITM can't derive session key without both private keys
          // 5. Pairing key verification (above) - proves sender intended to reach us

          // Handshake verified - store info for session key derivation
          senderEphemeralPub = parsed.senderEphemeralPub
          transferId = parsed.transferId
          senderPubkey = event.pubkey
          selectedCreatedAtSec = event.created_at || null
          eventNonce = parsed.nonce
          eventSalt = parsed.salt
          isHandshakeFlow = true
          break
        } else if (isMutualTrustMode && isSelfTransfer) {
          // Self-transfer mode: parse mutual trust event (has payload)
          const parsed = parseMutualTrustEvent(event)
          if (!parsed) continue

          // === SECURITY VERIFICATION 1: Sender fingerprint (constant-time) ===
          if (!constantTimeEqual(parsed.senderFingerprint, expectedSenderFingerprint!)) {
            console.log('Sender fingerprint mismatch')
            continue
          }

          // === SECURITY VERIFICATION 2: Receiver public ID commitment ===
          // Verify this event was addressed to us (prevents relay MITM)
          if (!ownPublicKeyBytes) {
            console.error('Own public ID not available for RPKC verification')
            continue
          }
          const rpkcValid = await verifyPublicKeyCommitment(ownPublicKeyBytes, parsed.receiverPkCommitment)
          if (!rpkcValid) {
            console.log('Receiver public ID commitment mismatch - event not addressed to us')
            continue
          }

          // Verify closure variables are available
          if (!deriveKeyWithSalt) {
            console.error('Key derivation function not available')
            continue
          }
          if (!sharedSecretKey) {
            console.error('Shared secret key not available for key confirmation')
            continue
          }

          try {
            // Derive key using closure function
            const derivedKey = await deriveKeyWithSalt(parsed.salt)

            // Try to decrypt
            const decrypted = await decrypt(derivedKey, parsed.encryptedPayload)
            const decoder = new TextDecoder()
            const payloadStr = decoder.decode(decrypted)
            payload = JSON.parse(payloadStr) as PinExchangePayload

            // === SECURITY VERIFICATION 3: Key confirmation ===
            // Verify we derived the same shared secret (detects MITM)
            const confirmValue = await deriveKeyConfirmationFromSecretKey(sharedSecretKey, parsed.salt)
            const computedKcHash = await hashKeyConfirmation(confirmValue)
            if (!constantTimeEqual(computedKcHash, parsed.keyConfirmHash)) {
              console.error('Key confirmation mismatch - potential MITM attack')
              continue
            }

            // === PFS VERIFICATION: Verify sender's ephemeral key binding ===
            // In passkey mode, PFS is mandatory - sender MUST provide ephemeral keys
            if (!parsed.senderEphemeralPub || !parsed.senderSessionBinding) {
              console.error('Sender did not provide ephemeral keys - PFS is mandatory in passkey mode')
              continue
            }

            if (!identitySharedSecretKey) {
              console.error('Identity shared secret not available for ephemeral key verification')
              continue
            }

            const bindingValid = await verifySessionBinding(
              identitySharedSecretKey,
              parsed.senderEphemeralPub,
              parsed.senderSessionBinding
            )
            if (!bindingValid) {
              console.error('Sender ephemeral key binding invalid - potential MITM')
              continue
            }
            // Store sender's ephemeral key for session key derivation
            senderEphemeralPub = parsed.senderEphemeralPub

            transferId = parsed.transferId
            senderPubkey = event.pubkey
            key = derivedKey
            selectedCreatedAtSec = event.created_at || null
            // Store nonce for ready ACK echo (replay protection)
            eventNonce = parsed.nonce
            // Store salt for session key derivation
            eventSalt = parsed.salt
            break
          } catch {
            continue
          }
        } else {
          // PIN mode
          const parsed = parsePinExchangeEvent(event)
          if (!parsed) continue

          try {
            const derivedKey = await deriveKeyFromPinKey(pinMaterial!.key, parsed.salt)
            const decrypted = await decrypt(derivedKey, parsed.encryptedPayload)
            const decoder = new TextDecoder()
            const payloadStr = decoder.decode(decrypted)
            payload = JSON.parse(payloadStr) as PinExchangePayload

            transferId = parsed.transferId
            senderPubkey = event.pubkey
            key = derivedKey
            selectedCreatedAtSec = event.created_at || null
            break
          } catch {
            continue
          }
        }
      }

      // For handshake flow, we don't have payload yet (it comes after ACK)
      // For other modes, we need payload from the initial event
      if (!isHandshakeFlow && (!payload || !key)) {
        if (!sawNonExpiredCandidate && sawExpiredCandidate) {
          setState({ status: 'error', message: 'Transfer expired. Ask sender to start a new transfer.' })
          return
        }
        setState({
          status: 'error',
          message: isMutualTrustMode
            ? 'Could not decrypt transfer. Wrong sender public ID?'
            : 'Could not decrypt transfer. Wrong PIN?',
        })
        return
      }

      if (!transferId || !senderPubkey) {
        if (!sawNonExpiredCandidate && sawExpiredCandidate) {
          setState({ status: 'error', message: 'Transfer expired. Ask sender to start a new transfer.' })
          return
        }
        setState({
          status: 'error',
          message: isMutualTrustMode
            ? 'No transfer found from this sender'
            : 'Could not decrypt transfer. Wrong PIN?',
        })
        return
      }

      if (!selectedCreatedAtSec || Date.now() - selectedCreatedAtSec * 1000 > TRANSFER_EXPIRATION_MS) {
        setState({ status: 'error', message: 'Transfer expired. Ask sender to generate a new PIN.' })
        return
      }

      if (cancelledRef.current) return

      // Generate receiver keypair
      const { secretKey } = generateEphemeralKeys()

      // PFS: Derive session encryption key from ephemeral ECDH
      // In passkey mode, this is mandatory - we already verified sender has ephemeral keys
      if (isMutualTrustMode && (!receiverEphemeral || !senderEphemeralPub || !eventSalt)) {
        throw new Error('Passkey mode requires ephemeral keys and salt for PFS key derivation')
      }
      if (receiverEphemeral && senderEphemeralPub && eventSalt) {
        // Derive session key from ephemeral ECDH
        // SECURITY: This key is derived from ephemeral keys whose private material
        // was NEVER exposed as raw bytes, providing true Perfect Forward Secrecy
        key = await deriveSessionEncryptionKey(
          receiverEphemeral.ephemeralPrivateKey,
          senderEphemeralPub,
          eventSalt
        )
      }

      // Send ready ACK (seq=0) - include nonce for replay protection in mutual trust mode
      // Include receiver's ephemeral key and binding for PFS
      // For cross-user passkey: include receiver's pairing key proving intent to communicate with sender
      const receiverPairingKey = isCrossUserPasskey && 'senderPairingKey' in arg
        ? (arg as ReceiveOptions).senderPairingKey
        : undefined

      // Compute receiver's handshake proof for cross-user mode
      let receiverHandshakeProof: Uint8Array | undefined
      if (isCrossUserPasskey && receiverParsedPairingKey && ownPublicKeyBytes && receiverEphemeral && eventNonce) {
        // Get receiver's verification secret from the parsed pairing key
        const receiverVs = getOwnVerificationSecret(receiverParsedPairingKey, ownPublicKeyBytes)
        // Decode the nonce from base64 for proof computation
        // Note: eventNonce was already validated at line ~324 in the cross-user handshake path,
        // but we add defensive error handling for safety and consistency
        let nonceBytes: Uint8Array
        try {
          nonceBytes = Uint8Array.from(atob(eventNonce), c => c.charCodeAt(0))
        } catch {
          console.error('Failed to decode eventNonce for receiver handshake proof - this should not happen as nonce was validated earlier')
          throw new Error('Internal error: corrupted nonce in receiver handshake proof computation')
        }
        // Get the sender's fingerprint from the parsed pairing key
        const senderFromPairingKey = getPeerFromParsedPairingKey(receiverParsedPairingKey, ownPublicKeyBytes)
        // Compute the receiver's proof: HMAC(receiver_vs, receiver_epk || nonce || sender_fingerprint)
        receiverHandshakeProof = await computeHandshakeProof(
          receiverVs,
          receiverEphemeral.ephemeralPublicKeyBytes,
          nonceBytes,
          senderFromPairingKey.fingerprint
        )
      }

      const readyAck = createAckEvent(
        secretKey,
        senderPubkey,
        transferId,
        0,
        hint,
        eventNonce,
        receiverEphemeral?.ephemeralPublicKeyBytes,
        receiverEphemeral?.sessionBinding,
        receiverPairingKey,
        receiverHandshakeProof
      )
      await client.publish(readyAck)

      // === MEMORY CLEANUP ===
      // Now that we have the session key (key) and have published the ACK (which needed the ephemeral public key),
      // we no longer need the passkey master secrets or the ephemeral private key.
      // Explicitly clear them to minimize exposure window.
      receiverEphemeral = null
      identitySharedSecretKey = null
      sharedSecretKey = null
      deriveKeyWithSalt = null // Release closure capturing master key

      if (cancelledRef.current) return

      // For handshake flow, wait for payload event and decrypt it
      if (isHandshakeFlow) {
        setState({ status: 'receiving', message: 'Waiting for encrypted metadata...' })

        // Wait for payload event from sender
        const payloadEvent = await new Promise<Event | null>((resolve) => {
          // Declare subId before timeout so both can access it safely
          // eslint-disable-next-line prefer-const
          let subId: string | undefined

          const timeout = setTimeout(() => {
            if (subId !== undefined) client.unsubscribe(subId)
            resolve(null)
          }, 60000) // 1 minute timeout for payload

          subId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId!],
                authors: [senderPubkey!],
              },
            ],
            (event) => {
              const parsed = parseMutualTrustPayloadEvent(event)
              if (parsed && parsed.transferId === transferId) {
                clearTimeout(timeout)
                if (subId !== undefined) client.unsubscribe(subId)
                resolve(event)
              }
            }
          )

            // Also check existing events
            ; (async () => {
              try {
                const existingEvents = await client.query([
                  {
                    kinds: [EVENT_KIND_DATA_TRANSFER],
                    '#t': [transferId!],
                    authors: [senderPubkey!],
                    limit: 10,
                  },
                ])
                for (const event of existingEvents) {
                  const parsed = parseMutualTrustPayloadEvent(event)
                  if (parsed && parsed.transferId === transferId) {
                    clearTimeout(timeout)
                    if (subId !== undefined) client.unsubscribe(subId)
                    resolve(event)
                    return
                  }
                }
              } catch (err) {
                console.error('Failed to query existing payload events:', err)
              }
            })()
        })

        if (!payloadEvent) {
          setState({ status: 'error', message: 'Timeout waiting for encrypted payload from sender' })
          return
        }

        if (cancelledRef.current) return

        // Parse and decrypt payload
        const parsedPayload = parseMutualTrustPayloadEvent(payloadEvent)
        if (!parsedPayload) {
          setState({ status: 'error', message: 'Invalid payload event from sender' })
          return
        }

        if (!key) {
          setState({ status: 'error', message: 'Session key not available for decryption' })
          return
        }

        try {
          const decrypted = await decrypt(key, parsedPayload.encryptedPayload)
          const decoder = new TextDecoder()
          const payloadStr = decoder.decode(decrypted)
          payload = JSON.parse(payloadStr) as PinExchangePayload
        } catch (err) {
          console.error('Failed to decrypt payload:', err)
          setState({ status: 'error', message: 'Failed to decrypt transfer metadata' })
          return
        }
      }

      // Validate payload (now available for all flows)
      if (!payload) {
        setState({ status: 'error', message: 'No transfer metadata available' })
        return
      }

      if (payload.fileSize == null || !Number.isFinite(payload.fileSize) || payload.fileSize < 0) {
        setState({ status: 'error', message: 'Invalid file size in transfer' })
        return
      }

      const resolvedFileName = payload.fileName || 'unknown'
      const resolvedFileSize = payload.fileSize
      const resolvedMimeType = payload.mimeType || 'application/octet-stream'

      if (resolvedFileSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${Math.round(resolvedFileSize / 1024 / 1024)}MB) exceeds limit (${MAX_MESSAGE_SIZE / 1024 / 1024}MB)`,
        })
        return
      }

      if (cancelledRef.current) return

      setState({
        status: 'receiving',
        message: 'Receiving file...',
        contentType: 'file',
        fileMetadata: {
          fileName: resolvedFileName,
          fileSize: resolvedFileSize,
          mimeType: resolvedMimeType,
        },
        useWebRTC: false,
        currentRelays: client.getRelays(),
        totalRelays: DEFAULT_RELAYS.length,
      })

      // Unified listener for P2P and cloud transfer
      let webRTCSuccess = false
      const receivedCloudChunkIndices: Set<number> = new Set()
      let cloudBuffer: Uint8Array | null = null
      let cloudTotalBytes = 0
      let expectedTotalChunks = payload.totalChunks || 1

      const transferResult = await new Promise<{ mode: 'p2p' | 'cloud' | 'inline'; data: Uint8Array }>(
        (resolve, reject) => {
          let rtc: WebRTCConnection | null = null
          const expectedSize = resolvedFileSize
          let combinedBuffer: Uint8Array | null = expectedSize > 0 ? new Uint8Array(expectedSize) : null
          const receivedChunkIndices: Set<number> = new Set()
          const pendingChunkPromises: Set<Promise<void>> = new Set()
          let totalDecryptedBytes = 0
          let settled = false
          let cloudTransferStarted = false

          const overallTimeout = setTimeout(() => {
            if (!settled) {
              settled = true
              if (rtc) rtc.close()
              client.unsubscribe(subId)
              reject(new Error('Transfer timeout'))
            }
          }, 10 * 60 * 1000)

          const initWebRTC = () => {
            if (rtc) return rtc

            rtc = new WebRTCConnection(
              getWebRTCConfig(),
              async (signal) => {
                const signalPayload = { type: 'signal', signal }
                const signalJson = JSON.stringify(signalPayload)
                const encryptedSignal = await encrypt(key!, new TextEncoder().encode(signalJson))
                const event = createSignalingEvent(secretKey, senderPubkey!, transferId!, encryptedSignal)
                await client.publish(event)
              },
              () => {
                setState((s) => ({ ...s, message: 'Receiving via P2P...', useWebRTC: true }))
              },
              (data) => {
                if (typeof data === 'string' && data.startsWith('DONE:')) {
                  void (async () => {
                    const expectedChunks = parseInt(data.split(':')[1], 10)
                    if (!Number.isFinite(expectedChunks)) {
                      reject(new Error('Invalid DONE message: missing chunk count'))
                      return
                    }

                    if (pendingChunkPromises.size > 0) {
                      await Promise.allSettled(Array.from(pendingChunkPromises))
                    }

                    if (receivedChunkIndices.size !== expectedChunks) {
                      reject(
                        new Error(`Missing chunks: got ${receivedChunkIndices.size}, expected ${expectedChunks}`)
                      )
                      return
                    }

                    if (!settled) {
                      settled = true
                      clearTimeout(overallTimeout)
                      client.unsubscribe(subId)
                      if (rtc) {
                        rtc.send('DONE_ACK')
                        rtc.close()
                      }

                      const result = combinedBuffer
                        ? combinedBuffer.slice(0, totalDecryptedBytes)
                        : new Uint8Array(0)

                      webRTCSuccess = true
                      resolve({ mode: 'p2p', data: result })
                    }
                  })()
                  return
                }

                if (typeof data === 'string' && data === 'DONE') {
                  reject(new Error('Unsupported sender: missing chunk count. Ask sender to update and retry.'))
                  return
                }

                if (data instanceof ArrayBuffer) {
                  if (settled) return
                  const decryptPromise = (async () => {
                    try {
                      const { chunkIndex, encryptedData } = parseChunkMessage(data)
                      const decryptedChunk = await decryptChunk(key!, encryptedData)
                      const writePosition = chunkIndex * ENCRYPTION_CHUNK_SIZE
                      const requiredSize = writePosition + decryptedChunk.length

                      if (!combinedBuffer || combinedBuffer.length < requiredSize) {
                        const newBuffer = new Uint8Array(
                          Math.max(requiredSize, (combinedBuffer?.length || 0) * 2)
                        )
                        if (combinedBuffer) {
                          newBuffer.set(combinedBuffer)
                        }
                        combinedBuffer = newBuffer
                      }

                      combinedBuffer.set(decryptedChunk, writePosition)
                      receivedChunkIndices.add(chunkIndex)
                      totalDecryptedBytes += decryptedChunk.length

                      setState((s) => ({
                        ...s,
                        status: 'receiving',
                        progress: {
                          current: totalDecryptedBytes,
                          total: resolvedFileSize,
                        },
                      }))
                    } catch (err) {
                      console.error('Failed to decrypt chunk:', err)
                    }
                  })()
                  pendingChunkPromises.add(decryptPromise)
                  decryptPromise.finally(() => {
                    pendingChunkPromises.delete(decryptPromise)
                  })
                }
              }
            )
            return rtc
          }

          const handleChunkNotify = async (chunkPayload: ChunkNotifyPayload) => {
            if (settled) return

            if (!cloudTransferStarted) {
              cloudTransferStarted = true
              if (rtc) {
                rtc.close()
                rtc = null
              }
              const estimatedEncryptedSize = chunkPayload.totalChunks * CLOUD_CHUNK_SIZE
              cloudBuffer = new Uint8Array(estimatedEncryptedSize)
            }

            expectedTotalChunks = chunkPayload.totalChunks

            setState((s) => ({
              ...s,
              message: `Downloading chunk ${chunkPayload.chunkIndex + 1}/${chunkPayload.totalChunks}...`,
              useWebRTC: false,
            }))

            try {
              const chunkData = await downloadFromCloud(chunkPayload.chunkUrl, (loaded) => {
                setState((s) => ({
                  ...s,
                  progress: {
                    current: cloudTotalBytes + loaded,
                    total: resolvedFileSize,
                  },
                }))
              })

              const writePosition = chunkPayload.chunkIndex * CLOUD_CHUNK_SIZE
              const requiredSize = writePosition + chunkData.length

              if (!cloudBuffer || cloudBuffer.length < requiredSize) {
                const newBuffer = new Uint8Array(Math.max(requiredSize, (cloudBuffer?.length || 0) * 2))
                if (cloudBuffer) {
                  newBuffer.set(cloudBuffer)
                }
                cloudBuffer = newBuffer
              }

              cloudBuffer.set(chunkData, writePosition)
              receivedCloudChunkIndices.add(chunkPayload.chunkIndex)
              cloudTotalBytes += chunkData.length

              const chunkAck = createAckEvent(
                secretKey,
                senderPubkey!,
                transferId!,
                chunkPayload.chunkIndex + 1
              )
              await client.publish(chunkAck)

              if (receivedCloudChunkIndices.size === expectedTotalChunks) {
                settled = true
                clearTimeout(overallTimeout)
                client.unsubscribe(subId)
                const result = cloudBuffer.slice(0, cloudTotalBytes)
                resolve({ mode: 'cloud', data: result })
              }
            } catch (err) {
              console.error(`Failed to download chunk ${chunkPayload.chunkIndex}:`, err)
            }
          }

          const processedEventIds = new Set<string>()

          const processEvent = async (event: Event) => {
            if (settled) return
            if (processedEventIds.has(event.id)) return
            processedEventIds.add(event.id)

            if (!cloudTransferStarted) {
              const signalData = parseSignalingEvent(event)
              if (signalData && signalData.transferId === transferId) {
                try {
                  const decrypted = await decrypt(key!, signalData.encryptedSignal)
                  const signalPayload = JSON.parse(new TextDecoder().decode(decrypted))
                  if (signalPayload.type === 'signal' && signalPayload.signal) {
                    const r = initWebRTC()
                    r.handleSignal(signalPayload.signal)
                  }
                } catch (e) {
                  console.error('Signal handling error', e)
                }
                return
              }
            }

            const chunkNotify = parseChunkNotifyEvent(event)
            if (chunkNotify && chunkNotify.transferId === transferId) {
              if (!receivedCloudChunkIndices.has(chunkNotify.chunkIndex)) {
                await handleChunkNotify(chunkNotify)
              }
            }
          }

          const subId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId!],
                authors: [senderPubkey!],
              },
            ],
            processEvent
          )

            ; (async () => {
              try {
                const existingEvents = await client.query([
                  {
                    kinds: [EVENT_KIND_DATA_TRANSFER],
                    '#t': [transferId!],
                    authors: [senderPubkey!],
                    limit: 50,
                  },
                ])
                for (const event of existingEvents) {
                  await processEvent(event)
                }
              } catch (err) {
                console.error('Failed to query existing events:', err)
              }
            })()
        }
      )

      if (cancelledRef.current) return

      // Process received data
      let contentData: Uint8Array

      if (transferResult.mode === 'p2p') {
        contentData = transferResult.data
        webRTCSuccess = true
      } else {
        setState((s) => ({ ...s, message: 'Decrypting...' }))
        if (!key) {
          throw new Error('Session key not available for decryption')
        }
        contentData = await decrypt(key, transferResult.data)
      }

      if (cancelledRef.current) return

      // Send completion ACK
      const completeAck = createAckEvent(secretKey, senderPubkey, transferId, -1)
      await client.publish(completeAck)

      // Set received content
      setReceivedContent({
        contentType: 'file',
        data: contentData,
        fileName: resolvedFileName,
        fileSize: resolvedFileSize,
        mimeType: resolvedMimeType,
      })

      setState((prevState) => ({
        status: 'complete',
        message: webRTCSuccess ? 'File received (P2P)!' : 'File received!',
        contentType: 'file',
        fileMetadata: {
          fileName: resolvedFileName,
          fileSize: resolvedFileSize,
          mimeType: resolvedMimeType,
        },
        currentRelays: prevState.currentRelays,
        totalRelays: prevState.totalRelays,
        useWebRTC: prevState.useWebRTC,
      }))
    } catch (error) {
      if (!cancelledRef.current) {
        setState((prevState) => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
        }))
      }
    } finally {
      receivingRef.current = false
      if (clientRef.current) {
        clientRef.current.close()
        clientRef.current = null
      }
    }
  }, [])

  return { state, receivedContent, ownPublicKey, ownFingerprint, receive, cancel, reset }
}
