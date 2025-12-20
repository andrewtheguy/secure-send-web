import { Routes, Route, Navigate } from 'react-router-dom'
import { Navbar } from '@/components/navbar'
import { SendPage } from '@/pages/send'
import { ReceivePage } from '@/pages/receive'
import { AboutPage } from '@/pages/about'

function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 px-6 py-10">
        <Routes>
          <Route path="/" element={<SendPage />} />
          <Route path="/receive" element={<ReceivePage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
