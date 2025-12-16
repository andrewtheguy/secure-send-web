import { Send, Download, RefreshCw } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SendTab } from './send-tab'
import { ReceiveTab } from './receive-tab'
import { clearRelayCache } from '@/lib/nostr'

export function SecureSend() {
  const handleClearCache = () => {
    clearRelayCache()
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-2xl">Secure Send</CardTitle>
        <CardDescription>
          Send encrypted text messages using PIN-based encryption over Nostr relays
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
      <CardFooter className="justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearCache}
          className="text-muted-foreground text-xs"
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Clear relay cache
        </Button>
      </CardFooter>
    </Card>
  )
}
