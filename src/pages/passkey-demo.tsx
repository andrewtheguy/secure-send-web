import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  checkPRFSupport,
  createEncryptionPasskey,
  encryptMessageWithPasskey,
  decryptMessageWithPasskey,
  hasStoredCredential,
  clearStoredCredential,
  base64urlDecode,
} from '@/lib/crypto/passkey'

// Base64url encode for display
function base64urlEncode(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function PasskeyDemoPage() {
  // State - initialize hasPasskey from localStorage synchronously
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null)
  const [hasPasskey, setHasPasskey] = useState(() => hasStoredCredential())
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Encrypt state
  const [message, setMessage] = useState('')
  const [encryptedBlob, setEncryptedBlob] = useState('')

  // Decrypt state
  const [decryptInput, setDecryptInput] = useState('')
  const [decryptedMessage, setDecryptedMessage] = useState('')

  // Check PRF support on mount (async)
  useEffect(() => {
    checkPRFSupport().then(setPrfSupported)
  }, [])

  // Create passkey
  const handleCreatePasskey = async () => {
    setError(null)
    setStatus('Creating passkey...')

    try {
      const result = await createEncryptionPasskey()
      setHasPasskey(true)

      if (result.prfSupported) {
        setStatus('Passkey created with PRF support!')
      } else {
        setError('Passkey created but PRF not supported by this authenticator')
        setStatus('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create passkey')
      setStatus('')
    }
  }

  // Clear passkey
  const handleClearPasskey = () => {
    clearStoredCredential()
    setHasPasskey(false)
    setStatus('Passkey reference cleared')
    setEncryptedBlob('')
    setDecryptedMessage('')
  }

  // Encrypt message
  const handleEncrypt = async () => {
    if (!message.trim()) {
      setError('Enter a message to encrypt')
      return
    }

    setError(null)
    setStatus('Authenticate to encrypt...')

    try {
      const encrypted = await encryptMessageWithPasskey(message)
      const blob = base64urlEncode(encrypted)
      setEncryptedBlob(blob)
      setStatus('Encrypted! Copy the blob below.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Encryption failed')
      setStatus('')
    }
  }

  // Decrypt message
  const handleDecrypt = async () => {
    if (!decryptInput.trim()) {
      setError('Paste an encrypted blob to decrypt')
      return
    }

    setError(null)
    setStatus('Authenticate to decrypt...')

    try {
      const blob = base64urlDecode(decryptInput.trim())
      const decrypted = await decryptMessageWithPasskey(blob)
      setDecryptedMessage(decrypted)
      setStatus('Decrypted!')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decryption failed')
      setStatus('')
    }
  }

  // Copy to clipboard
  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setStatus('Copied to clipboard!')
  }

  return (
    <div className="flex w-full justify-center">
      <div className="w-full max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Passkey Encryption Demo</CardTitle>
            <CardDescription>
              Encrypt data using WebAuthn PRF extension. Works across devices with synced passkeys
              (1Password, iCloud, Google).
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* PRF Support Status */}
            <div className="text-sm">
              <span className="font-medium">PRF Support: </span>
              {prfSupported === null ? (
                <span className="text-muted-foreground">Checking...</span>
              ) : prfSupported ? (
                <span className="text-green-600">Available</span>
              ) : (
                <span className="text-yellow-600">May not be available</span>
              )}
            </div>

            {/* Passkey Status & Actions */}
            <div className="flex items-center gap-4">
              <span className="text-sm">
                <span className="font-medium">Passkey: </span>
                {hasPasskey ? (
                  <span className="text-green-600">Configured</span>
                ) : (
                  <span className="text-muted-foreground">Not created</span>
                )}
              </span>

              {!hasPasskey ? (
                <Button onClick={handleCreatePasskey} size="sm">
                  Create Passkey
                </Button>
              ) : (
                <Button onClick={handleClearPasskey} variant="outline" size="sm">
                  Clear
                </Button>
              )}
            </div>

            {/* Status/Error */}
            {status && (
              <Alert>
                <AlertDescription>{status}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Encrypt Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Encrypt</CardTitle>
            <CardDescription>Type a message and encrypt it with your passkey</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <Textarea
              placeholder="Enter message to encrypt..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />

            <Button onClick={handleEncrypt} disabled={!message.trim()}>
              Encrypt with Passkey
            </Button>

            {encryptedBlob && (
              <div className="space-y-2">
                <div className="text-sm font-medium">Encrypted Blob:</div>
                <Textarea value={encryptedBlob} readOnly rows={4} className="font-mono text-xs" />
                <Button variant="outline" size="sm" onClick={() => handleCopy(encryptedBlob)}>
                  Copy
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Decrypt Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Decrypt</CardTitle>
            <CardDescription>
              Paste an encrypted blob and decrypt it with the same passkey (can be on a different
              device if passkeys are synced)
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <Textarea
              placeholder="Paste encrypted blob here..."
              value={decryptInput}
              onChange={(e) => setDecryptInput(e.target.value)}
              rows={4}
              className="font-mono text-xs"
            />

            <Button onClick={handleDecrypt} disabled={!decryptInput.trim()}>
              Decrypt with Passkey
            </Button>

            {decryptedMessage && (
              <div className="space-y-2">
                <div className="text-sm font-medium">Decrypted Message:</div>
                <Textarea value={decryptedMessage} readOnly rows={3} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* How it works */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">How It Works</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              <strong>1. Create Passkey:</strong> A discoverable credential is created and stored in
              your password manager (1Password, iCloud Keychain, Google Password Manager).
            </p>
            <p>
              <strong>2. Encrypt:</strong> The WebAuthn PRF extension derives a deterministic
              256-bit key from your passkey. This key encrypts your message with AES-256-GCM.
            </p>
            <p>
              <strong>3. Transfer:</strong> Copy the encrypted blob and send it via any channel
              (email, chat, etc.).
            </p>
            <p>
              <strong>4. Decrypt:</strong> On any device with the same synced passkey, paste the
              blob and authenticate. The same key is derived, decrypting the message.
            </p>
            <p className="pt-2 border-t">
              <strong>Key insight:</strong> Same passkey + same salt = same encryption key. This
              works across devices because password managers sync passkeys.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
