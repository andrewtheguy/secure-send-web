import { Send, Download, Info, Shield, Zap, Globe, Lock } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SendTab } from './send-tab'
import { ReceiveTab } from './receive-tab'

export function SecureSend() {
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-2xl">Secure Send</CardTitle>
        <CardDescription>
          Share files, folder, or text snippet securely with end-to-end encryption. Click About for more info.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="send" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="send" className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Send
            </TabsTrigger>
            <TabsTrigger value="receive" className="flex items-center gap-2">
              <Download className="h-4 w-4" />
              Receive
            </TabsTrigger>
            <TabsTrigger value="about" className="flex items-center gap-2">
              <Info className="h-4 w-4" />
              About
            </TabsTrigger>
          </TabsList>
          <TabsContent value="send">
            <SendTab />
          </TabsContent>
          <TabsContent value="receive">
            <ReceiveTab />
          </TabsContent>
          <TabsContent value="about">
            <div className="space-y-6 pt-4 text-sm">
              <section>
                <h3 className="font-semibold text-base mb-2">How It Works</h3>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                  <li>Select what you want to share (files, folder, or text)</li>
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
                </div>
              </section>

              <section>
                <h3 className="font-semibold text-base mb-2">Technical Details</h3>
                <ul className="space-y-1 text-muted-foreground">
                  <li><span className="text-foreground">Encryption:</span> AES-256-GCM with PBKDF2-SHA256 key derivation (600,000 iterations)</li>
                  <li><span className="text-foreground">PIN format:</span> 12 characters with built-in checksum for typo detection</li>
                  <li><span className="text-foreground">Max size:</span> 100 MB per transfer</li>
                  <li><span className="text-foreground">PIN expiry:</span> 1 hour</li>
                  <li><span className="text-foreground">Signaling:</span> Auto-detected from PIN (uppercase = Nostr, lowercase = PeerJS, "2" = QR)</li>
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
                    <p className="text-foreground font-medium">PeerJS — PIN starts with lowercase</p>
                    <p className="text-sm">Requires internet. Uses PeerJS cloud server for simpler P2P signaling. Devices can be on different networks. No cloud fallback - transfer fails if P2P connection cannot be established.</p>
                  </div>
                  <div>
                    <p className="text-foreground font-medium">Manual Exchange — PIN starts with "2"</p>
                    <p className="text-sm">No internet required. Exchange signaling via QR scan or copy/paste (camera optional). With internet, works across different networks via STUN. Without internet, devices must be on same local network. P2P only, no fallback.</p>
                  </div>
                </div>
              </section>

              <section className="pt-2 border-t">
                <p className="text-muted-foreground text-xs">
                  Open source on <a href="https://github.com/andrewtheguy/secure-send-web" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub</a>
                </p>
              </section>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
