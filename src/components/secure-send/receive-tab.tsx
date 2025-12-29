import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, X, RotateCcw, FileDown, QrCode, KeyRound, Fingerprint, ChevronDown, ChevronRight, ArrowRight, Keyboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { PinInput, type PinInputRef, type PinChangePayload } from './pin-input'
import { TransferStatus } from './transfer-status'
import { QRDisplay } from './qr-display'
import { QRInput } from './qr-input'
import { useNostrReceive } from '@/hooks/use-nostr-receive'
import { useManualReceive } from '@/hooks/use-manual-receive'
import { downloadFile, formatFileSize, getMimeTypeDescription } from '@/lib/file-utils'
import type { SignalingMethod } from '@/lib/nostr/types'
import type { PinKeyMaterial } from '@/lib/types'
import { Link } from 'react-router-dom'
import { formatFingerprint } from '@/lib/crypto/ecdh'
import { isContactTokenFormat, verifyContactToken, type VerifiedContactToken } from '@/lib/crypto/contact-token'

const PIN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// Helper to format PIN hint as XXXX-XXXX
function formatPinHint(h: string): string {
  const compact = h.slice(0, 8).toUpperCase()
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`
}

type PinSecret = PinKeyMaterial & { method: SignalingMethod | null }

type ReceiveMode = 'pin' | 'scan'

export function ReceiveTab() {
  const [receiveMode, setReceiveMode] = useState<ReceiveMode>('pin')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [usePasskey, setUsePasskey] = useState(false)
  const [receiveFromSelf, setReceiveFromSelf] = useState(false)
  const [passkeyAuthenticating, setPasskeyAuthenticating] = useState(false)
  const [senderPublicIdInput, setSenderPublicIdInput] = useState('')
  const [senderPublicIdError, setSenderPublicIdError] = useState<string | null>(null)
  const [showPublicIdModal, setShowPublicIdModal] = useState(false)

  // Store PIN in ref to avoid React DevTools exposure
  const pinSecretRef = useRef<PinSecret | null>(null)
  const pinInputLengthRef = useRef(0)
  const pinInputRef = useRef<PinInputRef>(null)
  const [isPinValid, setIsPinValid] = useState(false)
  const [pinExpired, setPinExpired] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(0)
  const [, setDetectedMethod] = useState<SignalingMethod>('nostr')
  const [pinFingerprint, setPinFingerprint] = useState<string | null>(null)

  // Verified token state (updated via useEffect since verification is async)
  const [verifiedToken, setVerifiedToken] = useState<VerifiedContactToken | null>(null)

  // Verify sender contact token - now verifies signature immediately
  useEffect(() => {
    const input = senderPublicIdInput.trim()
    if (!input) {
      setVerifiedToken(null)
      setSenderPublicIdError(null)
      return
    }

    // Quick format check first
    if (!isContactTokenFormat(input)) {
      setVerifiedToken(null)
      setSenderPublicIdError('Invalid format: expected bound contact token (create one on the Passkey page)')
      return
    }

    // Verify token signature - no authentication required!
    verifyContactToken(input).then(verified => {
      setVerifiedToken(verified)
      setSenderPublicIdError(null)
    }).catch((err) => {
      setVerifiedToken(null)
      setSenderPublicIdError(err instanceof Error ? err.message : 'Invalid or tampered token')
    })
  }, [senderPublicIdInput])

  // Auto-expand Advanced Options when passkey mode is enabled
  useEffect(() => {
    if (usePasskey) {
      setShowAdvanced(true)
    }
  }, [usePasskey])

  // All hooks must be called unconditionally (React rules)
  const nostrHook = useNostrReceive()
  const manualHook = useManualReceive()

  // Determine which hook to use based on mode
  const isManualMode = receiveMode === 'scan'

  const activeHook = isManualMode ? manualHook : nostrHook

  const { state: rawState, receivedContent, cancel, reset } = activeHook

  // Get own fingerprint from nostr hook for verification display (only in nostr mode)
  const receiverOwnFingerprint = !isManualMode ? nostrHook.ownFingerprint : null

  // Get the right receive function based on mode
  // nostrHook has .receive, manualHook does not
  const pinReceive: ((secret: PinSecret) => Promise<void>) | undefined =
    !isManualMode && 'receive' in activeHook && typeof activeHook.receive === 'function'
      ? activeHook.receive
      : undefined
  const { startReceive, submitOffer } = manualHook

  // Use rawState directly for common properties
  const state = rawState

  // Runtime normalization for manual-mode specific properties
  const rawStateAny = rawState as unknown as Record<string, unknown>
  const answerData: Uint8Array | undefined =
    rawStateAny.answerData instanceof Uint8Array
      ? rawStateAny.answerData
      : undefined
  const clipboardData: string | undefined =
    typeof rawStateAny.clipboardData === 'string'
      ? rawStateAny.clipboardData
      : undefined

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinInactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  // Clear PIN inactivity timeout and countdown
  const clearPinInactivityTimeout = useCallback(() => {
    if (pinInactivityRef.current) {
      clearTimeout(pinInactivityRef.current)
      pinInactivityRef.current = null
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    setTimeRemaining(0)
  }, [])

  // Reset PIN inactivity timeout (called on each PIN change)
  const resetPinInactivityTimeout = useCallback((hasInput: boolean) => {
    clearPinInactivityTimeout()
    setPinExpired(false)

    // Only set timeout if there's some PIN input
    if (hasInput) {
      // Set initial countdown time
      setTimeRemaining(Math.floor(PIN_INACTIVITY_TIMEOUT_MS / 1000))

      // Start countdown interval
      countdownIntervalRef.current = setInterval(() => {
        if (!mountedRef.current) return
        setTimeRemaining(prev => Math.max(0, prev - 1))
      }, 1000)

      // Set expiration timeout
      pinInactivityRef.current = setTimeout(() => {
        if (mountedRef.current && (pinSecretRef.current || pinInputLengthRef.current > 0)) {
          // Clear PIN due to inactivity
          pinSecretRef.current = null
          pinInputLengthRef.current = 0
          setIsPinValid(false)
          pinInputRef.current?.clear()
          setPinExpired(true)
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current)
            countdownIntervalRef.current = null
          }
          setTimeRemaining(0)
        }
      }, PIN_INACTIVITY_TIMEOUT_MS)
    }
  }, [clearPinInactivityTimeout])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Clear PIN from memory on unmount
      pinSecretRef.current = null
      pinInputLengthRef.current = 0
      const timeoutId = timeoutRef.current
      const countdownId = countdownIntervalRef.current
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (countdownId) {
        clearInterval(countdownId)
      }
      timeoutRef.current = null
      countdownIntervalRef.current = null
      clearPinInactivityTimeout()
    }
  }, [clearPinInactivityTimeout])

  // Format time remaining as MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const canReceivePin = isPinValid && state.status === 'idle'
  const canReceiveScan = state.status === 'idle'

  const handleReceivePin = () => {
    const secret = pinSecretRef.current
    if (canReceivePin && secret && pinReceive) {
      clearPinInactivityTimeout()
      // Clear stored material immediately after retrieving it
      pinSecretRef.current = null
      pinInputLengthRef.current = 0
      setIsPinValid(false)
      pinInputRef.current?.clear()
      setPinExpired(false)
      pinReceive(secret)
    }
  }

  const handleReceiveScan = () => {
    if (canReceiveScan) {
      startReceive()
    }
  }

  const handleReset = () => {
    reset()
    clearPinInactivityTimeout()
    // Clear PIN from ref and input
    pinSecretRef.current = null
    pinInputLengthRef.current = 0
    setIsPinValid(false)
    pinInputRef.current?.clear()
    setPinExpired(false)
    // Clear passkey state
    setSenderPublicIdInput('')
    setSenderPublicIdError(null)
    setReceiveFromSelf(false)
  }

  const handlePinChange = useCallback((payload: PinChangePayload) => {
    const { key, hint, method, isValid, length } = payload
    pinInputLengthRef.current = length

    if (isValid && key && hint) {
      pinSecretRef.current = { key, hint, method: method ?? null }
      setIsPinValid(true)
      setPinFingerprint(formatPinHint(hint))
    } else {
      pinSecretRef.current = null
      setIsPinValid(false)
      setPinFingerprint(null)
    }

    resetPinInactivityTimeout(length > 0)

    if (method) {
      setDetectedMethod(method)
    } else if (length === 0) {
      setDetectedMethod('nostr')
    }
  }, [resetPinInactivityTimeout])

  const handleDownload = () => {
    if (receivedContent) {
      downloadFile(receivedContent.data, receivedContent.fileName, receivedContent.mimeType)
    }
  }

  // Handle passkey authentication for receiving
  const handlePasskeyAuth = async () => {
    if (passkeyAuthenticating) return
    if (!receiveFromSelf && !verifiedToken) return // Require verified sender token unless receiving from self

    setPasskeyAuthenticating(true)

    try {
      // Start receive with passkey mode and sender contact token (or self-transfer)
      // Token will be verified when passkey authenticates
      await nostrHook.receive({
        usePasskey: true,
        selfTransfer: receiveFromSelf,
        senderContactToken: !receiveFromSelf && senderPublicIdInput.trim() ? senderPublicIdInput.trim() : undefined,
      })
    } catch {
      // Error will be handled by the hook
    } finally {
      setPasskeyAuthenticating(false)
    }
  }

  // Whether passkey mode requirements are met (either have verified sender token or receiving from self)
  const passkeyRequirementsMet = receiveFromSelf || verifiedToken !== null

  const isActive = state.status !== 'idle' && state.status !== 'error' && state.status !== 'complete'
  const showQRInput = isManualMode && state.status === 'waiting_for_offer'
  const showQRDisplay = isManualMode && answerData && state.status === 'showing_answer'

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <Tabs value={receiveMode} onValueChange={(v) => setReceiveMode(v as ReceiveMode)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="pin" className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                Enter PIN
              </TabsTrigger>
              <TabsTrigger value="scan" className="flex items-center gap-2">
                <QrCode className="h-4 w-4" />
                Scan Code
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {receiveMode === 'pin' ? (
            <>
              {usePasskey ? (
                <>
                  {/* Advanced Options containing passkey settings */}
                  <div className="border rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="w-full flex items-center gap-2 p-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                      {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      Advanced Options
                      <span className="ml-auto text-xs bg-primary/10 border border-primary/20 px-2 py-0.5 rounded">
                        Passkey
                      </span>
                    </button>
                    {showAdvanced && (
                      <div className="p-3 pt-0 space-y-3 border-t">
                        {/* Passkey toggle */}
                        <div className="pt-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Fingerprint className="h-4 w-4 text-muted-foreground" />
                              <Label htmlFor="use-passkey-receive" className="text-sm font-medium cursor-pointer">
                                Use Passkey to receive
                              </Label>
                            </div>
                            <Switch
                              id="use-passkey-receive"
                              checked={usePasskey}
                              onCheckedChange={setUsePasskey}
                            />
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            Receive from a specific sender using their public ID. No PIN needed.
                          </p>
                        </div>

                        {/* Receive from self checkbox and sender public ID input */}
                        <div className="space-y-3 pt-2 border-t border-dashed">
                          <div className="flex items-center gap-2">
                            <input
                              id="receive-from-self"
                              type="checkbox"
                              className="h-4 w-4 rounded border-gray-300"
                              checked={receiveFromSelf}
                              onChange={(e) => setReceiveFromSelf(e.target.checked)}
                            />
                            <Label htmlFor="receive-from-self" className="text-sm font-normal cursor-pointer">
                              Receive from myself
                            </Label>
                          </div>
                          {receiveFromSelf && (
                            <p className="text-xs text-muted-foreground">
                              Receive files you sent from another device using the same passkey.
                            </p>
                          )}

                          {/* Sender contact token input - hidden when receiving from self */}
                          {!receiveFromSelf && (
                            <>
                              <Label htmlFor="sender-pubkey" className="text-sm font-medium">
                                Sender&apos;s Bound Token
                              </Label>
                              <div className="flex gap-2">
                                <Textarea
                                  id="sender-pubkey"
                                  placeholder="Paste bound contact token from your Passkey page..."
                                  value={senderPublicIdInput}
                                  onChange={(e) => setSenderPublicIdInput(e.target.value)}
                                  className="font-mono text-xs min-h-[60px] resize-none"
                                />
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setShowPublicIdModal(true)}
                                  className="flex-shrink-0"
                                  title="Enter contact token"
                                >
                                  <Keyboard className="h-4 w-4" />
                                </Button>
                              </div>
                              {senderPublicIdError && (
                                <p className="text-xs text-destructive">{senderPublicIdError}</p>
                              )}
                              {verifiedToken && (
                                <div className="space-y-1 text-xs">
                                  <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                                    <Fingerprint className="h-3 w-3" />
                                    <span>Sender:</span>
                                    <span className="font-mono font-medium">{formatFingerprint(verifiedToken.recipientFingerprint)}</span>
                                  </div>
                                  <div className="flex items-center gap-2 text-muted-foreground ml-5">
                                    <span>Signed by:</span>
                                    <span className="font-mono">{formatFingerprint(verifiedToken.signerFingerprint)}</span>
                                    <span className="text-green-600 dark:text-green-400">(verified)</span>
                                  </div>
                                </div>
                              )}
                              <p className="text-xs text-muted-foreground">
                                Create a bound token on your{' '}
                                <Link to="/passkey" className="text-primary hover:underline">
                                  Passkey page
                                </Link>{' '}
                                using the sender&apos;s public ID
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Contact token entry modal */}
                  {showPublicIdModal && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                      <div className="bg-background rounded-lg p-4 max-w-md w-full mx-4 space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="font-medium">Enter Bound Contact Token</h3>
                          <Button variant="ghost" size="sm" onClick={() => setShowPublicIdModal(false)}>
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Paste the bound contact token you created on your Passkey page.
                        </p>
                        <Textarea
                          placeholder="Paste bound contact token..."
                          value={senderPublicIdInput}
                          onChange={(e) => setSenderPublicIdInput(e.target.value)}
                          className="font-mono text-xs min-h-[100px]"
                          autoFocus
                        />
                        <Button onClick={() => setShowPublicIdModal(false)} className="w-full">
                          Done
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Passkey mode indicator */}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground bg-primary/10 border border-primary/20 px-3 py-2 rounded">
                    <Fingerprint className="h-3 w-3" />
                    <span>Passkey mode{receiveFromSelf ? ' → receiving from self' : verifiedToken ? ` → sender ${formatFingerprint(verifiedToken.recipientFingerprint)}` : ' (enter sender token in Advanced Options)'}</span>
                  </div>

                  <Button
                    onClick={handlePasskeyAuth}
                    disabled={passkeyAuthenticating || !passkeyRequirementsMet}
                    className="w-full bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
                  >
                    <Fingerprint className="mr-2 h-4 w-4" />
                    {passkeyAuthenticating ? 'Authenticating...' : receiveFromSelf ? 'Authenticate & Receive from Self' : passkeyRequirementsMet ? 'Authenticate & Receive' : 'Enter sender\'s ID first'}
                  </Button>
                </>
              ) : (
                <>
                  {/* Regular PIN mode */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Enter PIN from sender</label>
                    <PinInput ref={pinInputRef} onPinChange={handlePinChange} disabled={isActive} />
                    {timeRemaining > 0 && (
                      <p className="text-xs text-amber-600 font-medium">
                        PIN will be cleared in {formatTime(timeRemaining)}
                      </p>
                    )}
                    {pinExpired && (
                      <p className="text-xs text-muted-foreground">
                        PIN cleared due to inactivity. Please re-enter.
                      </p>
                    )}
                  </div>

                  {isPinValid && pinFingerprint && (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2 font-mono">
                        <Fingerprint className="h-3 w-3" />
                        PIN Fingerprint: {pinFingerprint}
                      </div>
                      <p>- It should match the sender's PIN fingerprint if you entered the same words/PIN.</p>
                      <p>- After you enter the correct PIN the app locks it into a key that cannot be read back out; this fingerprint is the one-way checksum you can compare to confirm both sides derived the same secret, and it cannot be reversed to recover the PIN or decrypt any data.</p>
                    </div>
                  )}

                  <div className="text-xs text-muted-foreground text-center pb-2">
                    Your connection is encrypted and private. Files are never stored unencrypted.
                  </div>

                  <div className="border rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="w-full flex items-center gap-2 p-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                      {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      Advanced Options
                      {usePasskey && (
                        <span className="ml-auto text-xs bg-primary/10 border border-primary/20 px-2 py-0.5 rounded">
                          Passkey
                        </span>
                      )}
                    </button>
                    {showAdvanced && (
                      <div className="p-3 pt-0 space-y-3 border-t">
                        <div className="pt-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Fingerprint className="h-4 w-4 text-muted-foreground" />
                              <Label htmlFor="use-passkey-receive" className="text-sm font-medium cursor-pointer">
                                Use Passkey to receive
                              </Label>
                            </div>
                            <Switch
                              id="use-passkey-receive"
                              checked={usePasskey}
                              onCheckedChange={setUsePasskey}
                            />
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {usePasskey
                              ? 'Skip PIN entry. Authenticate with the same synced passkey as the sender.'
                              : 'Use your passkey instead of entering a PIN. Both sender and receiver must have the same passkey.'}
                          </p>
                          {!usePasskey && (
                            <p className="text-xs text-muted-foreground">
                              Use the{' '}
                              <Link to="/passkey" className="text-primary hover:underline">
                                Passkey setup page
                              </Link>{' '}
                              to create, manage your passkey or get your passkey&apos;s public ID.
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <Button onClick={handleReceivePin} disabled={!canReceivePin} className="w-full bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700">
                    <Download className="mr-2 h-4 w-4" />
                    Receive
                  </Button>
                </>
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Scan or paste the sender's code to receive their content. No PIN required.
                </p>
              </div>

              <Button onClick={handleReceiveScan} disabled={!canReceiveScan} className="w-full bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700">
                <Download className="mr-2 h-4 w-4" />
                Start Receive
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <TransferStatus state={state} />

          {/* Passkey authentication help */}
          {state.status === 'connecting' && state.message?.toLowerCase().includes('passkey') && (
            <div className="text-xs text-muted-foreground border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2 rounded space-y-1">
              <p>A passkey prompt should appear from your browser or password manager.</p>
              <p className="text-amber-700 dark:text-amber-400">
                If no prompt appears, you may not have a passkey registered for this app yet.
              </p>
              <p>
                <Link to="/passkey" className="text-primary hover:underline inline-flex items-center gap-1">
                  Set up a passkey first <ArrowRight className="h-3 w-3" />
                </Link>
                {' '}— you'll need the same passkey synced from the sender (via 1Password, iCloud, Google, etc.)
              </p>
            </div>
          )}

          {/* Show receiver's own fingerprint during transfer for verification */}
          {receiverOwnFingerprint && (
            <div className="text-xs text-muted-foreground border border-cyan-500/30 bg-cyan-50/30 dark:bg-cyan-950/20 px-3 py-2 rounded">
              <div className="flex items-center gap-2 font-mono">
                <Fingerprint className="h-3 w-3 text-cyan-600" />
                <span>Your fingerprint: </span>
                <span className="font-medium text-cyan-600">
                  {formatFingerprint(receiverOwnFingerprint)}
                </span>
              </div>
              <p className="mt-1 ml-5">Sender should verify this matches your public ID.</p>
            </div>
          )}

          {/* QR Input for receiving offer */}
          {showQRInput && (
            <div className="space-y-4">
              <QRInput
                expectedType="offer"
                label="Scan or paste the sender's code"
                onSubmit={submitOffer}
              />
            </div>
          )}

          {/* QR Code display for receiver's answer */}
          {showQRDisplay && answerData && (
            <div className="space-y-4">
              <QRDisplay
                data={answerData}
                clipboardData={clipboardData}
                label="Show this to sender and wait for connection"
              />
            </div>
          )}

          {state.status === 'complete' && receivedContent && (
            <div className="space-y-4">
              <div className="p-6 border rounded-lg bg-muted/50 text-center space-y-3">
                <FileDown className="h-12 w-12 mx-auto text-muted-foreground" />
                <div>
                  <p className="font-medium truncate max-w-[300px] mx-auto">
                    {receivedContent.fileName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatFileSize(receivedContent.fileSize)} &bull;{' '}
                    {getMimeTypeDescription(receivedContent.mimeType)}
                  </p>
                </div>
                <Button onClick={handleDownload} className="w-full max-w-[200px] bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700">
                  <Download className="mr-2 h-4 w-4" />
                  Download File
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            {isActive && (
              <Button variant="outline" onClick={cancel} className="flex-1">
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            )}

            {(state.status === 'complete' || state.status === 'error') && (
              <Button variant="outline" onClick={handleReset} className="flex-1">
                <RotateCcw className="mr-2 h-4 w-4" />
                Receive Another
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
