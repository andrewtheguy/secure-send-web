import { SecureSend } from '@/components/secure-send'

export function ReceivePage() {
  return (
    <div className="flex w-full justify-center">
      <SecureSend defaultTab="receive" />
    </div>
  )
}
