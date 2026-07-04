#!/usr/bin/env npx tsx
/**
 * Cross-implementation interop check between the xfer-webrtc CLI (Rust) and this
 * web app's own crypto/signaling library.
 *
 * Verifies, byte-for-byte:
 *   1. SS03 manual signaling  (Rust encodes -> web parses, web encodes -> Rust parses)
 *   2. ECDH P-256 + HKDF-SHA256 content-key agreement
 *   3. AES-256-GCM chunk wire format incl. the 2-byte index AAD (both directions)
 *
 * Usage: npx tsx scripts/interop-check.ts [path-to-rust-interop-binary]
 */

import { execFileSync } from 'node:child_process';
import {
  decryptChunk,
  encryptChunk,
  parseChunkMessage,
} from '../src/lib/crypto/stream-crypto';
import {
  deriveSharedSecretKey,
  generateECDHKeyPair,
} from '../src/lib/crypto/ecdh';
import {
  generateMutualOfferBinary,
  generateMutualClipboardData,
  parseMutualPayload,
} from '../src/lib/manual-signaling';

const RUST_BIN =
  process.argv[2] ||
  '/home/debian/codes/xfer-webrtc/target/debug/examples/interop';

function rust(...args: string[]): string {
  return execFileSync(RUST_BIN, args, { encoding: 'utf8' }).trim();
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h.trim(), 'hex'));

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${detail ? ` -- ${detail}` : ''}`);
    failures++;
  }
}

async function testSs03RustToWeb() {
  console.log('SS03: Rust encodes -> web parses');
  const out = JSON.parse(rust('encode-ss03'));
  const binary = new Uint8Array(Buffer.from(out.base64, 'base64'));
  const payload = parseMutualPayload(binary);
  check('web decoded a Rust-encoded offer', payload !== null);
  if (!payload) return;
  check('type', payload.type === 'offer');
  check('sdp', payload.sdp === out.sdp);
  check(
    'candidates',
    JSON.stringify(payload.candidates) === JSON.stringify(out.candidates),
  );
  check('createdAt', payload.createdAt === out.createdAt);
  check('fileName', payload.fileName === out.fileName);
  check('fileSize', payload.fileSize === out.fileSize);
  check('totalBytes', payload.totalBytes === out.totalBytes);
  check('mimeType', payload.mimeType === out.mimeType);
  check(
    'publicKey',
    toHex(new Uint8Array(payload.publicKey)) === out.publicKeyHex,
  );
  check('salt', toHex(new Uint8Array(payload.salt ?? [])) === out.saltHex);
}

async function testSs03WebToRust() {
  console.log('SS03: web encodes -> Rust parses');
  const kp = await generateECDHKeyPair();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const offer = { type: 'offer', sdp: 'v=0\r\nweb-offer\r\n' };
  const candidates = [
    { candidate: 'candidate:1 1 udp 100 10.0.0.1 4444 typ host' } as RTCIceCandidate,
  ];
  const binary = generateMutualOfferBinary(offer, candidates, {
    createdAt: Date.now(),
    totalBytes: 2048,
    fileName: 'web.bin',
    fileSize: 2048,
    mimeType: 'application/octet-stream',
    publicKey: kp.publicKeyBytes,
    salt,
  });
  const base64 = generateMutualClipboardData(binary);
  const parsed = JSON.parse(rust('decode-ss03', base64));
  check('type', parsed.type === 'offer');
  check('sdp', parsed.sdp === 'v=0\r\nweb-offer\r\n');
  check('fileName', parsed.fileName === 'web.bin');
  check('totalBytes', parsed.totalBytes === 2048);
  check(
    'publicKey',
    toHex(new Uint8Array(parsed.publicKey)) === toHex(kp.publicKeyBytes),
  );
  check('salt', toHex(new Uint8Array(parsed.salt)) === toHex(salt));
}

async function testEcdhAgreement() {
  console.log('ECDH P-256 + HKDF-SHA256 key agreement');
  const kp = await generateECDHKeyPair();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const out = JSON.parse(
    rust('ecdh-derive', toHex(kp.publicKeyBytes), toHex(salt)),
  );
  const rustPub = fromHex(out.rustPubHex);

  // Reproduce deriveAESKeyFromSecretKey() but export raw bytes for comparison
  // (identical HKDF params: salt, info "secure-send-mutual", SHA-256, 256 bits).
  const sharedSecretKey = await deriveSharedSecretKey(kp.privateKey, rustPub);
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode('secure-send-mutual'),
    },
    sharedSecretKey,
    256,
  );
  const webKeyHex = toHex(new Uint8Array(keyBits));
  check('web and Rust derive the same AES key', webKeyHex === out.keyHex, out.keyHex);
}

async function testChunkFormat() {
  console.log('AES-256-GCM chunk wire format (2-byte index AAD)');
  const keyBytes = new Uint8Array(32).map((_, i) => i);
  const keyHex = toHex(keyBytes);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

  // Rust encrypts -> web decrypts
  const plaintext = new TextEncoder().encode('interop chunk payload \u{1f512}');
  const msgHex = rust('chunk-encrypt', keyHex, '7', toHex(plaintext));
  const { chunkIndex, encryptedData } = parseChunkMessage(fromHex(msgHex));
  check('web reads Rust chunk index', chunkIndex === 7);
  const webDecrypted = await decryptChunk(key, encryptedData, chunkIndex);
  check(
    'web decrypts a Rust-encrypted chunk',
    toHex(webDecrypted) === toHex(plaintext),
  );

  // Web encrypts -> Rust decrypts
  const webChunk = await encryptChunk(key, plaintext, 42);
  const rustPlainHex = rust('chunk-decrypt', keyHex, '42', toHex(webChunk));
  check(
    'Rust decrypts a web-encrypted chunk',
    rustPlainHex === toHex(plaintext),
  );
}

async function main() {
  console.log(`Using Rust interop binary: ${RUST_BIN}\n`);
  await testSs03RustToWeb();
  await testSs03WebToRust();
  await testEcdhAgreement();
  await testChunkFormat();
  console.log();
  if (failures === 0) {
    console.log('ALL INTEROP CHECKS PASSED');
  } else {
    console.error(`${failures} INTEROP CHECK(S) FAILED`);
    process.exit(1);
  }
}

void main();
