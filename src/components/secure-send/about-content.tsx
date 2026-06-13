import { KeyRound, Lock, QrCode, Shield, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OFFLINE_QR_TRANSFER_URL } from '@/lib/constants';
import { generateTextQRCode } from '@/lib/qr-utils';

const HOW_IT_WORKS = [
  'Select what you want to share (files or folder)',
  'Choose your transfer mode: PIN mode or QR code mode',
  'PIN mode: generate and share the PIN; QR code mode: exchange QR codes between devices',
  'Recipient follows the same mode to complete the encrypted transfer',
] as const;

const FEATURES = [
  {
    icon: Shield,
    title: 'End-to-End Encryption',
    description:
      'Your content is encrypted with AES-256-GCM before it ever leaves your device. Only someone with the PIN or completed QR exchange key can decrypt it.',
  },
  {
    icon: Zap,
    title: 'Direct P2P Transfer',
    description:
      'Files are sent directly between devices using WebRTC. File data never touches a server, only your two devices.',
  },
  {
    icon: Lock,
    title: 'No Accounts Required',
    description:
      "No sign-ups, no tracking. Each transfer uses a fresh ephemeral identity that's discarded after use.",
  },
] as const;

const TECHNICAL_DETAILS = [
  {
    label: 'Encryption:',
    value:
      'AES-256-GCM; PIN mode uses PBKDF2-SHA256 key derivation (600,000 iterations), QR code mode uses ECDH',
  },
  {
    label: 'PIN format:',
    value: '12 characters with built-in checksum for typo detection',
  },
  { label: 'Max size:', value: '100 MB per transfer' },
  { label: 'PIN expiry:', value: '1 hour' },
  {
    label: 'Signaling:',
    value:
      'Receiver chooses the matching mode (PIN mode uses relay signaling, QR code mode uses direct QR exchange)',
  },
] as const;

export function AboutContent() {
  const siteUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const [shareQrUrl, setShareQrUrl] = useState<string | null>(null);
  const [shareQrError, setShareQrError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!siteUrl) return;
    generateTextQRCode(siteUrl, { width: 220, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (active) setShareQrUrl(url);
      })
      .catch((err) => {
        if (active)
          setShareQrError(
            err instanceof Error ? err.message : 'Failed to generate QR code',
          );
      });
    return () => {
      active = false;
    };
  }, [siteUrl]);

  return (
    <div className="space-y-8 pt-4 text-sm">
      {/* How It Works */}
      <section>
        <h3 className="mb-3 text-base font-semibold">How It Works</h3>
        <ol className="grid gap-3 sm:grid-cols-2">
          {HOW_IT_WORKS.map((step, index) => (
            <li
              key={step}
              className="flex items-start gap-3 rounded-xl border bg-card p-3"
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {index + 1}
              </span>
              <span className="text-muted-foreground">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Features */}
      <section>
        <h3 className="mb-3 text-base font-semibold">Features</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div key={title} className="rounded-xl border bg-card p-4">
              <div className="inline-flex rounded-lg bg-primary/10 p-2 text-primary">
                <Icon className="h-5 w-5" />
              </div>
              <p className="mt-3 font-medium">{title}</p>
              <p className="mt-1 text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Technical Details */}
      <section>
        <h3 className="mb-3 text-base font-semibold">Technical Details</h3>
        <dl className="space-y-2 rounded-xl bg-muted/40 p-4">
          {TECHNICAL_DETAILS.map(({ label, value }) => (
            <div
              key={label}
              className="flex flex-col gap-0.5 sm:flex-row sm:gap-2"
            >
              <dt className="font-medium text-foreground sm:w-28 sm:flex-shrink-0">
                {label}
              </dt>
              <dd className="text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Transfer Modes */}
      <section>
        <h3 className="mb-2 text-base font-semibold">Transfer Modes</h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Select the mode before sending. Receiver uses the matching mode to
          complete the transfer.
        </p>
        <div className="grid gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <KeyRound className="h-4 w-4 text-primary" />
              PIN mode
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              More reliable option, but requires manual PIN input. Coordination
              happens through third-party relay servers. Relays can see routing
              metadata, but not plaintext file contents or your decryption key.
            </p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                Best when sender and receiver are on different networks and you
                want the highest connection success rate.
              </li>
              <li>
                PIN is shared out-of-band (chat, voice, etc.), then receiver
                enters it to derive the decryption key locally.
              </li>
              <li>
                Relay servers coordinate signaling only; they do not get
                plaintext file contents or your decryption key.
              </li>
              <li>
                File data is transferred directly peer-to-peer over WebRTC; if a
                direct connection cannot be established, the transfer does not
                complete. When devices are side by side, you can instead
                transfer the file offline with animated QR codes using{' '}
                <a
                  href={OFFLINE_QR_TRANSFER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline underline-offset-2"
                >
                  Secure QR Transfer
                </a>
                .
              </li>
            </ul>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <QrCode className="h-4 w-4 text-primary" />
              QR code mode
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Coordination happens directly through QR code exchange, with no
              third-party coordination servers. The QR/clipboard signaling
              payload is obfuscated, not encrypted, so exchange it only with the
              intended recipient. STUN may be used when internet is available;
              without internet, no third-party servers are involved at all. When
              STUN is used, it only sees connection setup metadata such as IP
              address and port, not file contents or encryption keys. File data
              remains encrypted throughout the transfer, regardless of internet
              availability and whether STUN is used.
            </p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                Best when you prefer direct device-to-device coordination using
                camera scan or copy/paste.
              </li>
              <li>
                Offer/answer signaling is exchanged as QR chunks, so no relay
                coordination service is required.
              </li>
              <li>
                With internet, STUN can assist network traversal for peer
                connection setup using only connection metadata (for example IP
                address and port).
              </li>
              <li>
                Without internet, transfer can still work over a shared local
                network with no third-party servers.
              </li>
              <li>
                Typically less reliable than PIN mode due to camera quality,
                scan conditions, and manual QR exchange friction.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Share App */}
      <section>
        <h3 className="mb-3 text-base font-semibold">Share App</h3>
        <div className="flex flex-col items-center gap-4 rounded-xl border bg-muted/40 p-4">
          {shareQrUrl && !shareQrError ? (
            <div className="flex flex-col items-center gap-2">
              <img
                src={shareQrUrl}
                alt="Scan to open on mobile"
                className="h-[220px] w-[220px] rounded-md border bg-white p-2"
              />
              <p className="text-xs text-muted-foreground">
                Scan to open on mobile
              </p>
            </div>
          ) : shareQrError ? (
            <div className="text-xs text-destructive">{shareQrError}</div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Generating QR code...
            </div>
          )}
          <p className="break-all text-center text-sm text-muted-foreground">
            {siteUrl}
          </p>
        </div>
      </section>

      <section className="border-t pt-4">
        <p className="text-xs text-muted-foreground">
          Source code available for audit at{' '}
          <a
            href="https://github.com/andrewtheguy/secure-send-web"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            GitHub
          </a>
        </p>
      </section>
    </div>
  );
}
