/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react'

export type MethodChoice = 'online' | 'offline'

interface SendConfig {
  // Files
  selectedFiles: File[]
  folderFiles: FileList | null

  // Configuration
  methodChoice: MethodChoice
  usePasskey: boolean
  relayOnly: boolean
}

interface SendContextState {
  // Configuration
  config: SendConfig | null

  // Actions
  setConfig: (config: SendConfig) => void
  clearConfig: () => void

  // Computed
  hasConfig: boolean
  totalFileSize: number
  fileCount: number
}

const SendContext = createContext<SendContextState | null>(null)

export function useSend() {
  const context = useContext(SendContext)
  if (!context) {
    throw new Error('useSend must be used within a SendProvider')
  }
  return context
}

interface SendProviderProps {
  children: ReactNode
}

export function SendProvider({ children }: SendProviderProps) {
  const [config, setConfig] = useState<SendConfig | null>(null)

  // Stable clearConfig reference for consumers
  const clearConfig = useCallback(() => setConfig(null), [])

  // Memoize context value to prevent unnecessary consumer re-renders
  const value = useMemo<SendContextState>(() => {
    const hasConfig = config !== null

    const totalFileSize = config
      ? config.folderFiles
        ? Array.from(config.folderFiles).reduce((sum, f) => sum + f.size, 0)
        : config.selectedFiles.reduce((sum, f) => sum + f.size, 0)
      : 0

    const fileCount = config
      ? config.folderFiles
        ? config.folderFiles.length
        : config.selectedFiles.length
      : 0

    return {
      config,
      setConfig,
      clearConfig,
      hasConfig,
      totalFileSize,
      fileCount,
    }
  }, [config, clearConfig])

  return <SendContext.Provider value={value}>{children}</SendContext.Provider>
}
