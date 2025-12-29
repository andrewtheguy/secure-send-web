import { useEffect, useState } from 'react'
import { Shield, Zap, Globe, Lock, Fingerprint } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SendTab } from './send-tab'
import { ReceiveTab } from './receive-tab'
import { generateTextQRCode } from '@/lib/qr-utils'

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

  useEffect(() => {
    return () => {
      if (shareQrUrl) {
        URL.revokeObjectURL(shareQrUrl)
      }
    }
  }, [shareQrUrl])

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
          {view === 'send' && 'Share files or folders securely with end-to-end encryption.'}
          {view === 'receive' && 'Enter a PIN to securely receive files or messages.'}
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
                <li>Click "Generate PIN & Send" to create a unique 12-character PIN</li>
                <li>Share the PIN with your recipient through any channel (voice, chat, etc.)</li>
                <li>Recipient enters the PIN to instantly receive your content</li>
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
                <li><span className="text-foreground">Signaling:</span> Auto-detected from PIN (uppercase = Nostr, "2" = QR/Manual)</li>
              </ul>
            </section>

            <section>
              <h3 className="font-semibold text-base mb-2">Signaling Methods</h3>
              <p className="text-muted-foreground text-sm mb-3">Sender chooses the method in Advanced Options. Receiver auto-detects from PIN format.</p>
              <div className="space-y-3 text-muted-foreground">
                <div>
                  <p className="text-foreground font-medium">Nostr (Default) — PIN starts with uppercase</p>
                  <p className="text-sm">Requires internet. Uses decentralized Nostr relays for signaling. Devices can be on different networks. If P2P connection fails, automatically falls back to encrypted cloud transfer.</p>
                </div>
                <div>
                  <p className="text-foreground font-medium">Manual Exchange — PIN starts with "2"</p>
                  <p className="text-sm">No internet required. Exchange signaling via QR scan or copy/paste (camera optional). With internet, works across different networks via STUN. Without internet, devices must be on same local network. P2P only, no fallback.</p>
                </div>
              </div>
            </section>

            <section>
              <h3 className="font-semibold text-base mb-2">Passkey Mode</h3>
              <p className="text-muted-foreground text-sm mb-3">Alternative to PIN - uses WebAuthn for passwordless encryption.</p>
              <div className="space-y-2 text-muted-foreground text-sm">
                <p><span className="text-foreground font-medium">Setup:</span> Create a passkey at <a href="/passkey" className="text-primary hover:underline">/passkey</a> - stored in your password manager</p>
                <p><span className="text-foreground font-medium">Sync:</span> Both parties need the same passkey synced (1Password, iCloud Keychain, Google Password Manager)</p>
                <p><span className="text-foreground font-medium">Verify:</span> Compare fingerprints (16-hex identifier) to confirm same passkey</p>
                <p><span className="text-foreground font-medium">Security:</span> Keys derived from device secure hardware via WebAuthn PRF extension</p>
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
