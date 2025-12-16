import { ModeToggle } from '@/components/mode-toggle'
import { SecureSend } from '@/components/secure-send'

function App() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 relative">
      <div className="absolute top-4 right-4">
        <ModeToggle />
      </div>
      <SecureSend />
    </div>
  )
}

export default App
