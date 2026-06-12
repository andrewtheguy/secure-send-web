import { AlertCircle, Check, Copy, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { generateMutualClipboardData } from '@/lib/manual-signaling';
import { generateBinaryQRCode } from '@/lib/qr-utils';

interface QRDisplayProps {
  data: Uint8Array; // Binary data for QR code (SS03 obfuscated payload)
  label?: string;
  showCopyButton?: boolean;
  clipboardData?: string; // Base64 payload for copy button
  showSize?: boolean;
}

const MIN_QR_SIZE = 150;

export function QRDisplay({
  data,
  label,
  showCopyButton = true,
  clipboardData,
  showSize = true,
}: QRDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data || data.length === 0) {
      setQrImageUrl(null); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    const measuredWidth = containerRef.current?.clientWidth ?? 0;
    const qrWidth = Math.max(measuredWidth, MIN_QR_SIZE);

    setIsGenerating(true);
    setError(null);

    generateBinaryQRCode(data, {
      width: qrWidth,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        setQrImageUrl(url);
      })
      .catch((err) => {
        console.error('Failed to generate QR code:', err);
        setError('Failed to generate QR code');
        setQrImageUrl(null);
      })
      .finally(() => setIsGenerating(false));
  }, [data]);

  // Copy signaling payload as base64 for paste flow.
  const handleCopy = useCallback(async () => {
    if (!data || data.length === 0) return;
    try {
      const copyPayload =
        clipboardData && clipboardData.length > 0
          ? clipboardData
          : generateMutualClipboardData(data);
      await navigator.clipboard.writeText(copyPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [clipboardData, data]);

  return (
    <div className="flex flex-col items-center space-y-3">
      {label && (
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      )}

      <div className="p-4 bg-white rounded-lg w-full">
        <div
          ref={containerRef}
          className="flex items-center justify-center w-full"
        >
          {isGenerating ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          ) : error ? (
            <div className="text-destructive text-sm flex items-center">
              <AlertCircle className="h-4 w-4 mr-2" />
              {error}
            </div>
          ) : qrImageUrl ? (
            <img
              src={qrImageUrl}
              alt="QR Code"
              className="block w-full h-auto"
            />
          ) : null}
        </div>
      </div>

      {showSize && (
        <div className="text-xs text-muted-foreground">
          {data.length.toLocaleString()} bytes (compressed)
        </div>
      )}

      {showCopyButton && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          className="text-xs"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 mr-1 text-green-500" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 mr-1" />
              Copy Data
            </>
          )}
        </Button>
      )}
    </div>
  );
}
