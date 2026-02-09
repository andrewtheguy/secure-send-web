import { Routes, Route } from 'react-router-dom'
import { Navbar } from '@/components/navbar'
import { Footer } from '@/components/footer'
import { SendPage } from '@/pages/send'
import { SendLayout } from '@/pages/send/layout'
import { ReceivePage } from '@/pages/receive'
import { AboutPage } from '@/pages/about'
import {
  PasskeyLayout,
  PasskeyIndexPage,
  PasskeyCreatePage,
} from '@/pages/passkey'
import { SendTransferLayout } from '@/pages/send/transfer/layout'
import { SendTransferPage } from '@/pages/send/transfer'
import { ReceiveChunkedPage } from '@/pages/receive-chunked'
import { NotFoundPage } from '@/pages/not-found'

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
          <Route path="/passkey" element={<PasskeyLayout />}>
            <Route index element={<PasskeyIndexPage />} />
            <Route path="create" element={<PasskeyCreatePage />} />
          </Route>
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

export default App
