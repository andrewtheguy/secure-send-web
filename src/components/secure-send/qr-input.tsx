import { useState, useCallback } from 'react'
import { ClipboardPaste, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { parseQRPayload, isValidQRPayload, base64ToQRData, type QRSignalingPayload } from '@/lib/qr-signaling'

interface QRInputProps {
  onSubmit: (payload: QRSignalingPayload) => void
  expectedType: 'offer' | 'answer'
  label?: string
  disabled?: boolean
}

export function QRInput({ onSubmit, expectedType, label, disabled }: QRInputProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

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

    // Input is base64 encoded (from clipboard copy)
    // Convert to Latin-1 for parsing
    let qrData: string
    try {
      qrData = base64ToQRData(trimmed)
    } catch {
      setError('Invalid base64 data. Make sure you copied the complete text.')
      return
    }

    const payload = parseQRPayload(qrData)
    if (!payload) {
      setError('Invalid QR code data. Make sure you copied the complete text.')
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

  return (
    <div className="space-y-3">
      {label && (
        <p className="text-sm font-medium">{label}</p>
      )}

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

      <div className="flex gap-2">
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
    </div>
  )
}
