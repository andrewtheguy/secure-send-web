#!/usr/bin/env node
/**
 * Decrypt clipboard data from Secure Send QR mode
 * Usage: node scripts/decrypt-clipboard.mjs <pin> [base64-data]
 *    or: echo '<base64-data>' | node scripts/decrypt-clipboard.mjs <pin>
 */

import crypto from 'crypto'
import { createInterface } from 'readline'

async function readStdin() {
  const rl = createInterface({ input: process.stdin })
  const lines = []
  for await (const line of rl) {
    lines.push(line)
  }
  return lines.join('')
}

const PBKDF2_ITERATIONS = 600_000
const AES_NONCE_LENGTH = 12

async function deriveKey(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

async function decrypt(key, encrypted) {
  const nonce = encrypted.slice(0, AES_NONCE_LENGTH)
  const ciphertext = encrypted.slice(AES_NONCE_LENGTH, -16)
  const tag = encrypted.slice(-16)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ])

  return decrypted
}

async function main() {
  const [,, pin, base64Arg] = process.argv

  if (!pin) {
    console.error('Usage: node scripts/decrypt-clipboard.mjs <pin> [base64-data]')
    console.error('   or: echo "<base64-data>" | node scripts/decrypt-clipboard.mjs <pin>')
    process.exit(1)
  }

  // Read base64 data from argument or stdin
  const base64Data = base64Arg || await readStdin()

  if (!base64Data.trim()) {
    console.error('Error: No base64 data provided')
    process.exit(1)
  }

  // Decode base64
  const binary = Buffer.from(base64Data.trim(), 'base64')

  // Verify magic header "SS01"
  const magic = binary.slice(0, 4).toString('ascii')
  if (magic !== 'SS01') {
    console.error(`Invalid magic header: expected "SS01", got "${magic}"`)
    console.error('Hex bytes:', binary.slice(0, 4).toString('hex'))
    process.exit(1)
  }

  console.log('Magic header: SS01 ✓')
  console.log('Total binary length:', binary.length, 'bytes')

  // Extract salt and encrypted data
  const salt = binary.slice(4, 20)
  const encrypted = binary.slice(20)

  console.log('Salt:', salt.toString('hex'))
  console.log('Encrypted length:', encrypted.length, 'bytes')

  // Derive key
  console.log('\nDeriving key with PBKDF2 (600k iterations)...')
  const key = await deriveKey(pin, salt)

  // Decrypt
  try {
    const plaintext = await decrypt(key, encrypted)
    const json = plaintext.toString('utf8')


    console.log('\n=== Decrypted Payload Raw ===')
    console.log(json)

    const payload = JSON.parse(json)

    console.log('\n=== Decrypted Payload Prettified ===')
    console.log(JSON.stringify(payload, null, 2))
  } catch (err) {
    console.error('\nDecryption failed:', err.message)
    console.error('(Wrong PIN or corrupted data)')
    process.exit(1)
  }
}

main()
