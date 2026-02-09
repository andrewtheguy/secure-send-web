import { useEffect, useState } from 'react'
import { Shield, Zap, Globe, Lock, Fingerprint, Download } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SendTab } from './send-tab'
import { ReceiveTab } from './receive-tab'
import { generateTextQRCode } from '@/lib/qr-utils'
import { Link } from 'react-router-dom'

type SecureSendView = 'send' | 'receive' | 'about'

type SecureSendProps = {
  view?: SecureSendView
}

export function SecureSend({ view = 'send' }: SecureSendProps) {
  const siteUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const [shareQrUrl, setShareQrUrl] = useState<string | null>(null)
  const [shareQrError, setShareQrError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (!siteUrl) return
    generateTextQRCode(siteUrl, { width: 220, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (active) setShareQrUrl(url)
      })
      .catch((err) => {
        if (active) setShareQrError(err instanceof Error ? err.message : 'Failed to generate QR code')
      })
    return () => {
      active = false
    }
  }, [siteUrl])

  const getTitle = () => {
    switch (view) {
      case 'send':
        return 'Secure Send'
      case 'receive':
        return 'Secure Receive'
      case 'about':
        return 'About Secure Transfer'
      default:
        return 'Secure Send'
    }
  }

  const getCardClassName = () => {
    switch (view) {
      case 'receive':
        return 'w-full max-w-2xl border-cyan-200 dark:border-cyan-900/50 bg-gradient-to-br from-background to-cyan-50/30 dark:to-cyan-950/10'
      default:
        return 'w-full max-w-2xl'
    }
  }

  const getTitleClassName = () => {
    switch (view) {
      case 'send':
        return 'text-2xl text-primary'
      case 'receive':
        return 'text-2xl text-cyan-700 dark:text-cyan-500'
      default:
        return 'text-2xl'
    }
  }

  return (
    <Card className={getCardClassName()}>
      <CardHeader>
        <CardTitle className={getTitleClassName()}>{getTitle()}</CardTitle>
        <CardDescription>
          {view === 'send' && (
            <span className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <span>Share files or folders securely with end-to-end encryption.</span>
              <Link
                to="/receive"
                className="inline-flex items-center gap-1 text-primary hover:underline whitespace-nowrap"
              >
                <Download className="h-3 w-3" />
                <span>Receive files instead</span>
              </Link>
            </span>
          )}
          {view === 'receive' && 'Use PIN mode or QR code mode to securely receive files or messages.'}
          {view === 'about' && 'Learn how Secure Send works and what keeps it secure.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {view === 'send' && <SendTab />}
        {view === 'receive' && <ReceiveTab />}
        {view === 'about' && (
          <div className="space-y-6 pt-4 text-sm">
            <section>
              <h3 className="font-semibold text-base mb-2">How It Works</h3>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Select what you want to share (files or folder)</li>
                <li>Choose your transfer mode: PIN mode or QR code mode</li>
                <li>PIN mode: generate and share the PIN; QR code mode: exchange QR codes between devices</li>
                <li>Recipient follows the same mode to complete the encrypted transfer</li>
              </ol>
            </section>

            <section>
              <h3 className="font-semibold text-base mb-3">Features</h3>
              <div className="grid gap-3">
                <div className="flex gap-3">
                  <Shield className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">End-to-End Encryption</p>
                    <p className="text-muted-foreground">Your content is encrypted with AES-256-GCM before it ever leaves your device. Only someone with the PIN can decrypt it.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Zap className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Direct P2P Transfer</p>
                    <p className="text-muted-foreground">When possible, files are sent directly between devices using WebRTC for maximum speed and privacy.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Globe className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Cloud Fallback</p>
                    <p className="text-muted-foreground">If direct connection fails, encrypted data is temporarily stored in the cloud. Your content remains encrypted - servers never see the plaintext.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Lock className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">No Accounts Required</p>
                    <p className="text-muted-foreground">No sign-ups, no tracking. Each transfer uses a fresh ephemeral identity that's discarded after use.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Fingerprint className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Passkey Support</p>
                    <p className="text-muted-foreground">Use synced passkeys (1Password, iCloud Keychain, Google Password Manager) for passwordless encryption. No PIN to memorize.</p>
                  </div>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-semibold text-base mb-2">Technical Details</h3>
              <ul className="space-y-1 text-muted-foreground">
                <li><span className="text-foreground">Encryption:</span> AES-256-GCM with PBKDF2-SHA256 key derivation (600,000 iterations)</li>
                <li><span className="text-foreground">PIN format:</span> 12 characters with built-in checksum for typo detection</li>
                <li><span className="text-foreground">Passkey:</span> WebAuthn PRF extension for hardware-backed key derivation</li>
                <li><span className="text-foreground">Max size:</span> 100 MB per transfer</li>
                <li><span className="text-foreground">PIN expiry:</span> 1 hour</li>
                <li><span className="text-foreground">Signaling:</span> Auto-detected from code format (PIN mode uses relay signaling, QR code mode uses direct QR exchange)</li>
              </ul>
            </section>

            <section>
              <h3 className="font-semibold text-base mb-2">Transfer Modes</h3>
              <p className="text-muted-foreground text-sm mb-3">
                Select the mode before sending. Receiver uses the matching mode to complete the transfer.
              </p>
              <div className="space-y-4 text-muted-foreground">
                <div>
                  <p className="text-foreground font-medium">PIN mode</p>
                  <p className="text-sm">
                    More reliable option, but requires manual PIN input. Coordination happens through third-party relay servers.
                    No personally identifiable information is shared, and your data remains protected with end-to-end encryption.
                  </p>
                  <ul className="mt-2 space-y-1 text-sm list-disc list-inside">
                    <li>Best when sender and receiver are on different networks and you want the highest connection success rate.</li>
                    <li>PIN is shared out-of-band (chat, voice, etc.), then receiver enters it to derive the decryption key locally.</li>
                    <li>Relay servers coordinate signaling only; they do not get plaintext file contents or your decryption key.</li>
                    <li>If direct peer connection fails, encrypted cloud fallback can be used when enabled by the sender.</li>
                  </ul>
                </div>
                <div>
                  <p className="text-foreground font-medium">QR code mode</p>
                  <p className="text-sm">
                    Coordination happens directly through QR code exchange, with no third-party coordination servers.
                    STUN may be used when internet is available; without internet, no third-party servers are involved at all.
                    When STUN is used, it only sees connection setup metadata (such as IP address and port), not file contents, encryption keys, or any personally identifiable information.
                    Your data remains end-to-end encrypted throughout the transfer.
                  </p>
                  <ul className="mt-2 space-y-1 text-sm list-disc list-inside">
                    <li>Best when you prefer direct device-to-device coordination using camera scan or copy/paste.</li>
                    <li>Offer/answer signaling is exchanged as QR chunks, so no relay coordination service is required.</li>
                    <li>With internet, STUN can assist network traversal for peer connection setup using only connection metadata (for example IP address and port).</li>
                    <li>Without internet, transfer can still work over a shared local network with no third-party servers.</li>
                    <li>Typically less reliable than PIN mode due to camera quality, scan conditions, or manual QR exchange friction.</li>
                  </ul>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-semibold text-base mb-2">Passkey Mode (Self-Transfer)</h3>
              <p className="text-muted-foreground text-sm mb-3">Send files to yourself across devices - no PIN needed.</p>
              <div className="space-y-2 text-muted-foreground text-sm">
                <p><span className="text-foreground font-medium">Setup:</span> Create a passkey at <a href="/passkey" className="text-primary hover:underline">/passkey</a> - stored in your password manager</p>
                <p><span className="text-foreground font-medium">Sync:</span> Same passkey syncs across your devices (1Password, iCloud Keychain, Google Password Manager)</p>
                <p><span className="text-foreground font-medium">Use case:</span> Transfer files between your own devices without sharing codes</p>
                <p><span className="text-foreground font-medium">Security:</span> Hardware-backed keys via WebAuthn PRF, perfect forward secrecy</p>
              </div>
            </section>

            <section>
              <h3 className="font-semibold text-base mb-2">Share App</h3>
              <div className="flex flex-col items-center gap-4 p-4 border rounded-lg bg-muted/50">
                {shareQrUrl && !shareQrError ? (
                  <div className="flex flex-col items-center gap-2">
                    <img
                      src={shareQrUrl}
                      alt="Scan to open on mobile"
                      className="w-[220px] h-[220px] rounded-md border bg-white p-2"
                    />
                    <p className="text-xs text-muted-foreground">Scan to open on mobile</p>
                  </div>
                ) : (
                  <div className="text-xs text-destructive">
                    {shareQrError || 'Generating QR code...'}
                  </div>
                )}
                <p className="text-sm text-muted-foreground text-center break-all">
                  {siteUrl}
                </p>
              </div>
            </section>

            <section className="pt-2 border-t">
              <p className="text-muted-foreground text-xs">
                Source code available for audit at <a href="https://github.com/andrewtheguy/secure-send-web" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub</a>
              </p>
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
