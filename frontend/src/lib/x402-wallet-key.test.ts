import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPrivateKeyBackupText,
  IMPORTED_KEY_FORMAT_ERROR,
  parseImportedPrivateKey,
  privateKeyBackupFileName,
} from './x402-wallet-key';

const KEY = `0x${'ab'.repeat(32)}`;

test('accepts a 0x-prefixed 32-byte hex key and trims whitespace', () => {
  assert.deepEqual(parseImportedPrivateKey(`  ${KEY}\n`), { ok: true, privateKey: KEY });
});

test('rejects keys without the 0x prefix, of the wrong length, or with non-hex characters', () => {
  for (const bad of ['ab'.repeat(32), `0x${'ab'.repeat(31)}`, `0x${'zz'.repeat(32)}`, '']) {
    assert.deepEqual(parseImportedPrivateKey(bad), {
      ok: false,
      error: IMPORTED_KEY_FORMAT_ERROR,
    });
  }
});

test('backup text names the direction, address and key', () => {
  const text = buildPrivateKeyBackupText({ type: 'Selling', address: '0xabc', privateKey: KEY });
  assert.match(text, /Direction: Selling/);
  assert.match(text, /Address: {3}0xabc/);
  assert.ok(text.includes(`Private key: ${KEY}`));
});

test('backup file name uses the first 10 characters of the address', () => {
  assert.equal(privateKeyBackupFileName('0x1234567890abcdef'), 'x402-wallet-0x12345678.txt');
});
