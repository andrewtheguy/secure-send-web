/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'

export type PageState = 'idle' | 'checking' | 'creating'

interface PasskeyContextState {
  // UI state
  pageState: PageState
  error: string | null
  success: string | null

  // Actions
  setPageState: (state: PageState) => void
  setError: (error: string | null) => void
  setSuccess: (success: string | null) => void
  resetAll: () => void
}

const PasskeyContext = createContext<PasskeyContextState | null>(null)

export function usePasskey() {
  const context = useContext(PasskeyContext)
  if (!context) {
    throw new Error('usePasskey must be used within a PasskeyProvider')
  }
  return context
}

interface PasskeyProviderProps {
  children: ReactNode
}

export function PasskeyProvider({ children }: PasskeyProviderProps) {
  // UI state
  const [pageState, setPageState] = useState<PageState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Mounted ref for abort handling
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Auto-clear success message
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  const resetAll = useCallback(() => {
    setError(null)
    setSuccess(null)
    setPageState('idle')
  }, [])

  const value: PasskeyContextState = {
    // UI
    pageState,
    error,
    success,

    // Actions
    setPageState,
    setError,
    setSuccess,
    resetAll,
  }

  return <PasskeyContext.Provider value={value}>{children}</PasskeyContext.Provider>
}
