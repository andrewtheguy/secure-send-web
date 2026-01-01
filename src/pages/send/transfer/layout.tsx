import { Outlet, useNavigate } from 'react-router-dom'
import { Send, ArrowLeft } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useSend } from '@/contexts/send-context'
import { useEffect } from 'react'

export function SendTransferLayout() {
  const navigate = useNavigate()
  const { config, clearConfig } = useSend()

  // Redirect to home if no config (user navigated directly to transfer page)
  useEffect(() => {
    if (!config) {
      navigate('/', { replace: true })
    }
  }, [config, navigate])

  const handleBack = () => {
    navigate('/')
    clearConfig()
  }

  if (!config) {
    return null // Will redirect
  }

  return (
    <div className="flex w-full justify-center">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              className="h-8 w-8 p-0"
              aria-label="Go back to home"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <CardTitle className="text-2xl flex items-center gap-2">
                <Send className="h-6 w-6" />
                Secure Send
              </CardTitle>
              <CardDescription>
                Transferring {config.selectedFiles.length || config.folderFiles?.length || 0} file(s)
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <Outlet />
        </CardContent>
      </Card>
    </div>
  )
}
