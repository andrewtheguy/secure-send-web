import { useState, useCallback } from 'react'
import { ClipboardPaste, AlertCircle, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { parseQRPayload, isValidQRPayload, type QRSignalingPayload } from '@/lib/qr-signaling'
import { QRScanner } from './qr-scanner'
import { isMobileDevice } from '@/lib/utils'

interface QRInputProps {
  onSubmit: (payload: QRSignalingPayload) => void
  expectedType: 'offer' | 'answer'
  label?: string
  disabled?: boolean
}

export function QRInput({ onSubmit, expectedType, label, disabled }: QRInputProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [inputMode, setInputMode] = useState<'scan' | 'paste'>(
    isMobileDevice() ? 'scan' : 'paste'
  )

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      setValue(text)
      setError(null)
    } catch (err) {
      console.error('Failed to paste:', err)
      setError('Failed to read clipboard')
    }
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('Please paste QR code data')
      return
    }

    const payload = parseQRPayload(trimmed)
    if (!payload) {
      setError('Data format is invalid. Make sure you copied the complete text.')
      return
    }

    if (!isValidQRPayload(payload)) {
      setError('Malformed QR payload')
      return
    }

    if (payload.type !== expectedType) {
      setError(`Expected ${expectedType} QR code, got ${payload.type}`)
      return
    }

    setError(null)
    onSubmit(payload)
  }, [value, expectedType, onSubmit])

  const handleScanSuccess = useCallback((payload: QRSignalingPayload) => {
    setError(null)
    onSubmit(payload)
  }, [onSubmit])

  const handleScanError = useCallback((err: string) => {
    // Only show persistent errors, not transient scan failures
    if (err.includes('denied') || err.includes('unavailable')) {
      setError(err)
    }
  }, [])

  return (
    <div className="space-y-3">
      {label && (
        <p className="text-sm font-medium">{label}</p>
      )}

      <Tabs value={inputMode} onValueChange={(v) => setInputMode(v as 'scan' | 'paste')}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="scan" disabled={disabled}>
            <Camera className="h-4 w-4 mr-2" />
            Scan
          </TabsTrigger>
          <TabsTrigger value="paste" disabled={disabled}>
            <ClipboardPaste className="h-4 w-4 mr-2" />
            Paste
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="mt-3">
          <QRScanner
            expectedType={expectedType}
            onScan={handleScanSuccess}
            onError={handleScanError}
            disabled={disabled}
          />
        </TabsContent>

        <TabsContent value="paste" className="mt-3">
          <div className="space-y-2">
            <Textarea
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              placeholder={`Scan the ${expectedType} QR code with your phone, copy the text, and paste it here...`}
              className="min-h-[100px] font-mono text-xs"
              disabled={disabled}
            />

            {error && (
              <p className="text-xs text-destructive flex items-center">
                <AlertCircle className="h-3 w-3 mr-1" />
                {error}
              </p>
            )}
          </div>

          <div className="flex gap-2 mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePaste}
              disabled={disabled}
              className="flex-1"
            >
              <ClipboardPaste className="h-4 w-4 mr-2" />
              Paste from Clipboard
            </Button>

            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              className="flex-1"
            >
              Submit
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {inputMode === 'scan' && error && (
        <p className="text-xs text-destructive flex items-center">
          <AlertCircle className="h-3 w-3 mr-1" />
          {error}
        </p>
      )}
    </div>
  )
}
