import { Routes, Route } from 'react-router-dom'
import { Navbar } from '@/components/navbar'
import { Footer } from '@/components/footer'
import { SendPage } from '@/pages/send'
import { ReceivePage } from '@/pages/receive'
import { AboutPage } from '@/pages/about'
import {
  PasskeyLayout,
  PasskeyIndexPage,
  PasskeyCreatePage,
  PasskeyPairPage,
  PasskeyInvitePage,
  PasskeyConfirmPage,
  PasskeyRequestPage,
  PasskeyVerifyPage,
} from '@/pages/passkey'
import { SendTransferLayout } from '@/pages/send/transfer/layout'
import { SendTransferPage } from '@/pages/send/transfer'
import { SendProvider } from '@/contexts/send-context'
import { NotFoundPage } from '@/pages/not-found'

function App() {
  return (
    <SendProvider>
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1 px-6 py-10">
          <Routes>
            <Route path="/" element={<SendPage />} />
            <Route path="/receive" element={<ReceivePage />} />
            <Route path="/send/transfer" element={<SendTransferLayout />}>
              <Route index element={<SendTransferPage />} />
            </Route>
            <Route path="/passkey" element={<PasskeyLayout />}>
              <Route index element={<PasskeyIndexPage />} />
              <Route path="create" element={<PasskeyCreatePage />} />
              <Route path="pair" element={<PasskeyPairPage />} />
              <Route path="pair/invite" element={<PasskeyInvitePage />} />
              <Route path="pair/confirm" element={<PasskeyConfirmPage />} />
              <Route path="pair/request" element={<PasskeyRequestPage />} />
              <Route path="verify" element={<PasskeyVerifyPage />} />
            </Route>
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </SendProvider>
  )
}

export default App
