import {
  type RxingReaderOptions,
  readQrCodesFromImageData,
} from '@/lib/wasm/rxingWasm';

interface ScanMessage {
  type: 'scan';
  imageData: ImageData;
  options?: RxingReaderOptions;
}

interface ScanResult {
  type: 'result';
  data: Uint8Array[];
  error?: string;
}

self.onmessage = async (e: MessageEvent<ScanMessage>) => {
  if (e.data.type !== 'scan') return;

  try {
    const { imageData, options } = e.data;

    const readerOptions: RxingReaderOptions = {
      tryHarder: true,
      tryInvert: true,
      binarizer: 'hybrid',
      binarizerFallback: true,
      ...options,
    };

    const data = await readQrCodesFromImageData(imageData, readerOptions);

    const result: ScanResult = { type: 'result', data };
    self.postMessage(result);
  } catch (error) {
    const result: ScanResult = {
      type: 'result',
      data: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    self.postMessage(result);
  }
};
