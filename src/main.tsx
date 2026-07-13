import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import { PwaUpdatePrompt } from '@/components/pwa-update-prompt';
import { ThemeProvider } from '@/components/theme-provider';
import { sweepTransferScratch } from '@/lib/scratch-sink';
import App from './App.tsx';

// Remove receive-scratch plaintext a crashed or closed session left in OPFS.
void sweepTransferScratch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <BrowserRouter>
        <PwaUpdatePrompt />
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
