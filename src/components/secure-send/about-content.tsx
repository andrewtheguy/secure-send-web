import { KeyRound, Lock, QrCode, Shield, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  PinModeIllustration,
  PrivateByDesignIllustration,
  QrModeIllustration,
} from '@/components/illustrations';
import { SectionContainer } from '@/components/section-container';
import { OFFLINE_QR_TRANSFER_URL } from '@/lib/constants';
import { generateTextQRCode } from '@/lib/qr-utils';

const VALUE_PROPS = [
  { icon: Lock, label: 'End-to-end encrypted' },
  { icon: Zap, label: 'Direct peer-to-peer' },
  { icon: Shield, label: 'No sign-up' },
] as const;

// Shared by every transfer, whatever mode you use.
const COMMON_DETAILS = [
  { label: 'Content encryption:', value: 'AES-256-GCM' },
  { label: 'File transport:', value: 'Direct peer-to-peer over WebRTC' },
  { label: 'Max size:', value: '100 MB per transfer' },
] as const;

// Specific to PIN mode.
const PIN_DETAILS = [
  {
    label: 'Key derivation:',
    value: 'PBKDF2-SHA256 (600,000 iterations)',
  },
  {
    label: 'PIN format:',
    value: '12 characters with built-in checksum for typo detection',
  },
  { label: 'PIN expiry:', value: '1 hour' },
  { label: 'Signaling:', value: 'Relay signaling' },
] as const;

// Specific to QR code mode.
const QR_DETAILS = [
  { label: 'Key exchange:', value: 'ECDH' },
  { label: 'Signaling:', value: 'Direct QR exchange (no relay)' },
] as const;

function SpecList({
  items,
}: {
  items: readonly { label: string; value: string }[];
}) {
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-2 rounded-xl bg-muted/40 p-4 sm:grid-cols-2">
      {items.map(({ label, value }) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-foreground">{label}</dt>
          <dd className="text-xs text-muted-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

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
    <div className="flex flex-col gap-16 pb-8 sm:gap-24">
      {/* What is Secure Send */}
      <SectionContainer className="pt-2 sm:pt-6">
        <div className="grid items-center gap-10 md:grid-cols-2 md:gap-12">
          <div className="flex flex-col items-center text-center md:items-start md:text-left">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              What is Secure Send?
            </h1>

            <div className="mt-5 max-w-md space-y-4 text-pretty text-base text-muted-foreground">
              <p>
                Secure Send is a free, open-source tool for sending files and
                folders straight from one device to another with end-to-end
                encryption. Your content is encrypted in your browser and
                travels over a direct peer-to-peer connection — it's never
                uploaded to a server or stored in the cloud.
              </p>
              <p>
                There are no accounts and no tracking. Each transfer uses a
                fresh, throwaway identity, and the whole app is a static site
                with no backend, no database, and nothing to sign up for. It
                also installs as a Progressive Web App, so it keeps working
                offline.
              </p>
              <p>
                Two transfer modes cover different situations: a shareable{' '}
                <span className="font-medium text-foreground">PIN</span> for the
                most reliable connection across networks, or a direct{' '}
                <span className="font-medium text-foreground">QR code</span>{' '}
                exchange that can even work offline on the same local network.
              </p>
            </div>

            <ul className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground md:justify-start">
              {VALUE_PROPS.map(({ icon: Icon, label }) => (
                <li key={label} className="inline-flex items-center gap-1.5">
                  <Icon className="h-4 w-4 text-primary" />
                  {label}
                </li>
              ))}
            </ul>
          </div>

          <div className="order-first md:order-last">
            <PrivateByDesignIllustration className="mx-auto w-full max-w-md" />
          </div>
        </div>
      </SectionContainer>

      {/* Technical Details */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Technical details</h2>
          <p className="mt-3 text-muted-foreground">
            What's the same for every transfer, whichever mode you pick.
          </p>
        </div>
        <dl className="mt-8 grid gap-x-8 gap-y-3 rounded-2xl bg-muted/40 p-6 sm:grid-cols-3 sm:p-8">
          {COMMON_DETAILS.map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-sm font-medium text-foreground">{label}</dt>
              <dd className="text-sm text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </SectionContainer>

      {/* Transfer Modes */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Two ways to connect</h2>
          <p className="mt-3 text-muted-foreground">
            Every transfer is end-to-end encrypted — the two modes differ only
            in how the sending and receiving devices find each other.
          </p>
        </div>
        <div className="mt-10 grid gap-6">
          <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm sm:grid-cols-[200px_1fr] sm:items-start sm:gap-7">
            <PinModeIllustration className="mx-auto w-full max-w-[200px] sm:mx-0" />
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <KeyRound className="h-5 w-5 text-primary" />
                PIN mode
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                More reliable option, but requires manual PIN input.
                Coordination happens through third-party relay servers. Relays
                can see routing metadata, but not plaintext file contents or
                your decryption key.
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>
                  Best when sender and receiver are on different networks and
                  you want the highest connection success rate.
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
                  File data is transferred directly peer-to-peer over WebRTC; if
                  a direct connection cannot be established, the transfer does
                  not complete. When devices are side by side, you can instead
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
              <SpecList items={PIN_DETAILS} />
            </div>
          </div>
          <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm sm:grid-cols-[200px_1fr] sm:items-start sm:gap-7">
            <QrModeIllustration className="mx-auto w-full max-w-[200px] sm:mx-0" />
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <QrCode className="h-5 w-5 text-primary" />
                QR code mode
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Coordination happens directly through QR code exchange, with no
                third-party coordination servers. The QR/clipboard signaling
                payload is obfuscated, not encrypted, so exchange it only with
                the intended recipient. STUN may be used when internet is
                available; without internet, no third-party servers are involved
                at all. When STUN is used, it only sees connection setup
                metadata such as IP address and port, not file contents or
                encryption keys. File data remains encrypted throughout the
                transfer, regardless of internet availability and whether STUN
                is used.
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>
                  Best when you prefer direct device-to-device coordination
                  using camera scan or copy/paste.
                </li>
                <li>
                  Offer/answer signaling is exchanged as QR chunks, so no relay
                  coordination service is required.
                </li>
                <li>
                  With internet, STUN can assist network traversal for peer
                  connection setup using only connection metadata (for example
                  IP address and port).
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
              <SpecList items={QR_DETAILS} />
            </div>
          </div>
        </div>
      </SectionContainer>

      {/* Share App */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Share the app</h2>
          <p className="mt-3 text-muted-foreground">
            Scan to open Secure Send on another device.
          </p>
        </div>
        <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-4 rounded-2xl border bg-muted/40 p-6">
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
      </SectionContainer>

      {/* Source */}
      <SectionContainer>
        <p className="text-center text-xs text-muted-foreground">
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
      </SectionContainer>
    </div>
  );
}
