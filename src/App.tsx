import { Route, Routes } from 'react-router-dom';
import { Footer } from '@/components/footer';
import { Navbar } from '@/components/navbar';
import { AboutPage } from '@/pages/about';
import { NotFoundPage } from '@/pages/not-found';
import { ReceivePage } from '@/pages/receive';
import { ReceiveChunkedPage } from '@/pages/receive-chunked';
import { SendPage } from '@/pages/send';
import { SendLayout } from '@/pages/send/layout';
import { SendTransferPage } from '@/pages/send/transfer';
import { SendTransferLayout } from '@/pages/send/transfer/layout';

function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 px-6 py-10">
        <Routes>
          {/* Send routes wrapped with SendLayout */}
          <Route element={<SendLayout />}>
            <Route path="/" element={<SendPage />} />
            <Route path="/send/transfer" element={<SendTransferLayout />}>
              <Route index element={<SendTransferPage />} />
            </Route>
          </Route>
          <Route path="/receive" element={<ReceivePage />} />
          <Route path="/r" element={<ReceiveChunkedPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

export default App;
