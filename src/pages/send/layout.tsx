import { Outlet } from 'react-router-dom'
import { SendProvider } from '@/contexts/send-context'

export function SendLayout(): React.JSX.Element {
  return (
    <SendProvider>
      <Outlet />
    </SendProvider>
  )
}
