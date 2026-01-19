import { ChevronDown, ChevronRight, Fingerprint } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'

interface AdvancedOptionsPanelProps {
  showAdvanced: boolean
  setShowAdvanced: (value: boolean) => void
  usePasskey: boolean
  setUsePasskey: (value: boolean) => void
  description: ReactNode
  showPasskeyBadge?: boolean
  showPasskeySetupLink?: boolean
}

export function AdvancedOptionsPanel({
  showAdvanced,
  setShowAdvanced,
  usePasskey,
  setUsePasskey,
  description,
  showPasskeyBadge = false,
  showPasskeySetupLink = false,
}: AdvancedOptionsPanelProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="w-full flex items-center gap-2 p-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Advanced Options
        {showPasskeyBadge && (
          <span className="ml-auto text-xs bg-primary/10 border border-primary/20 px-2 py-0.5 rounded">
            Passkey
          </span>
        )}
      </button>
      {showAdvanced && (
        <div className="p-3 pt-0 space-y-3 border-t">
          <div className="pt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Fingerprint className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="use-passkey-receive" className="text-sm font-medium cursor-pointer">
                  Use Passkey to receive
                </Label>
              </div>
              <Switch
                id="use-passkey-receive"
                checked={usePasskey}
                onCheckedChange={setUsePasskey}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {description}
            </p>
            {showPasskeySetupLink && !usePasskey && (
              <p className="text-xs text-muted-foreground">
                Use the{' '}
                <Link to="/passkey" className="text-primary hover:underline">
                  Passkey setup page
                </Link>{' '}
                to create or manage your passkey.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
