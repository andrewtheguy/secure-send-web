import { Routes, Route } from 'react-router-dom'
import { Navbar } from '@/components/navbar'
import { Footer } from '@/components/footer'
import { SendPage } from '@/pages/send'
import { ReceivePage } from '@/pages/receive'
import { AboutPage } from '@/pages/about'
import { PasskeyPage } from '@/pages/passkey'
import { NotFoundPage } from '@/pages/not-found'

function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 px-6 py-10">
        <Routes>
          <Route path="/" element={<SendPage />} />
          <Route path="/receive" element={<ReceivePage />} />
          <Route path="/passkey" element={<PasskeyPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

export default App
