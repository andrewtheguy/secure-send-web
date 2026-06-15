import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 top-0 z-50 p-4">
      <Alert className="mx-auto max-w-md shadow-lg">
        <RefreshCw />
        <AlertTitle>Update available</AlertTitle>
        <AlertDescription>
          A new version is available. Reload to update.
        </AlertDescription>
        <div className="col-start-2 mt-2 flex gap-2">
          <Button size="sm" onClick={() => updateServiceWorker(true)}>
            Reload
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNeedRefresh(false)}
          >
            Dismiss
          </Button>
        </div>
      </Alert>
    </div>
  );
}
