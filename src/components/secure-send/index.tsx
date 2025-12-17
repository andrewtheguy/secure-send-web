import { Send, Download } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SendTab } from './send-tab'
import { ReceiveTab } from './receive-tab'

export function SecureSend() {
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-2xl">Secure Send</CardTitle>
        <CardDescription>
          Send encrypted messages and files using PIN-based encryption. WebRTC P2P with cloud fallback.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="send" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="send" className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Send
            </TabsTrigger>
            <TabsTrigger value="receive" className="flex items-center gap-2">
              <Download className="h-4 w-4" />
              Receive
            </TabsTrigger>
          </TabsList>
          <TabsContent value="send">
            <SendTab />
          </TabsContent>
          <TabsContent value="receive">
            <ReceiveTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
