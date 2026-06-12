import { AlertCircle, Check, Copy, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { buildChunkUrl, chunkPayload } from '@/lib/chunk-utils';
import { generateMutualClipboardData } from '@/lib/manual-signaling';
import { generateTextQRCode } from '@/lib/qr-utils';

interface MultiQRDisplayProps {
  data: Uint8Array;
  clipboardData?: string;
  showCopyButton?: boolean;
}

interface ChunkInfo {
  url: string;
  index: number;
  total: number;
}

const MIN_QR_SIZE = 150;

export function MultiQRDisplay({
  data,
  clipboardData,
  showCopyButton = true,
}: MultiQRDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [qrImageUrls, setQrImageUrls] = useState<Map<number, string>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const chunkInfos = useMemo((): ChunkInfo[] => {
    if (!data || data.length === 0) return [];
    const baseUrl = window.location.origin;
    const chunks = chunkPayload(data);
    return chunks.map((chunk, i) => ({
      url: buildChunkUrl(baseUrl, chunk),
      index: i,
      total: chunks.length,
    }));
  }, [data]);

  useEffect(() => {
    if (chunkInfos.length === 0) {
      setQrImageUrls(new Map());
      setError(null);
      return;
    }

    let active = true;

    const measuredWidth = containerRef.current?.clientWidth ?? 0;
    const qrWidth = Math.max(measuredWidth, MIN_QR_SIZE);

    setError(null);
    setQrImageUrls(new Map());

    Promise.allSettled(
      chunkInfos.map(async (info) => {
        const imageUrl = await generateTextQRCode(info.url, {
          width: qrWidth,
          errorCorrectionLevel: 'M',
        });
        return { index: info.index, imageUrl };
      }),
    )
      .then((results) => {
        if (!active) return;

        const urls = new Map<number, string>();
        let firstError: unknown = null;

        for (const result of results) {
          if (result.status === 'fulfilled') {
            urls.set(result.value.index, result.value.imageUrl);
          } else if (firstError === null) {
            firstError = result.reason;
          }
        }

        if (firstError !== null) {
          console.error('Failed to generate QR codes:', firstError);
          setError('Failed to generate QR codes');
          setQrImageUrls(new Map());
          return;
        }

        setQrImageUrls(urls);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to generate QR codes:', err);
        setError('Failed to generate QR codes');
        setQrImageUrls(new Map());
      });

    return () => {
      active = false;
    };
  }, [chunkInfos]);

  const handleCopy = useCallback(async () => {
    if (!data || data.length === 0) return;
    try {
      const copyPayload = clipboardData || generateMutualClipboardData(data);
      await navigator.clipboard.writeText(copyPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [clipboardData, data]);

  if (error) {
    return (
      <div className="flex items-center justify-center text-destructive text-sm py-8">
        <AlertCircle className="h-4 w-4 mr-2" />
        {error}
      </div>
    );
  }

  if (chunkInfos.length === 0) return null;

  return (
    <div className="flex flex-col items-center space-y-4">
      <div className="text-xs text-muted-foreground">
        {data.length.toLocaleString()} bytes &bull; {chunkInfos.length} QR code
        {chunkInfos.length !== 1 ? 's' : ''}
      </div>

      <div
        className={`grid gap-4 ${chunkInfos.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'} w-full max-w-[600px]`}
      >
        {chunkInfos.map((info, i) => (
          <div key={info.index} className="flex flex-col items-center gap-1">
            <div className="p-2 bg-white rounded-lg w-full">
              <div
                ref={i === 0 ? containerRef : undefined}
                className="flex items-center justify-center w-full"
              >
                {qrImageUrls.has(info.index) ? (
                  <img
                    src={qrImageUrls.get(info.index)}
                    alt={`QR Code ${info.index + 1} of ${info.total}`}
                    className="block w-full h-auto"
                  />
                ) : (
                  <div className="aspect-square w-full flex items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            </div>
            {info.total > 1 && (
              <p className="text-xs text-muted-foreground font-medium">
                {info.index + 1} of {info.total}
              </p>
            )}
          </div>
        ))}
      </div>

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
