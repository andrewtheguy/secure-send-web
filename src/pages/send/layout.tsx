import { Outlet } from 'react-router-dom'
import { SendProvider } from '@/contexts/send-context'

export function SendLayout() {
  return (
    <SendProvider>
      <Outlet />
    </SendProvider>
  )
}
