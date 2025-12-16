import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import { Button } from '@/components/ui/button'
import { ModeToggle } from '@/components/mode-toggle'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 relative">
      <div className="absolute top-4 right-4">
        <ModeToggle />
      </div>
      <div className="flex gap-8 mb-8">
        <a href="https://vite.dev" target="_blank">
          <img src={viteLogo} className="h-24 p-6 transition-all hover:drop-shadow-[0_0_2em_#646cffaa]" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="h-24 p-6 transition-all hover:drop-shadow-[0_0_2em_#61dafbaa] animate-spin [animation-duration:20s]" alt="React logo" />
        </a>
      </div>
      <h1 className="text-5xl font-bold mb-8">Vite + React</h1>
      <div className="p-8 text-center">
        <Button
          onClick={() => setCount((count) => count + 1)}
        >
          count is {count}
        </Button>
        <p className="mt-4 text-muted-foreground">
          Edit <code className="bg-muted px-1 py-0.5 rounded">src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="text-muted-foreground">
        Click on the Vite and React logos to learn more
      </p>
    </div>
  )
}

export default App
