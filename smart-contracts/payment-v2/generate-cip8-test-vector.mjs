// Generates the ed25519 test vectors embedded in validators/vested_pay.ak
// (the `withdraw_disputed_happy_path_*` tests). Deterministic: fixed mnemonic
// and fixed raw seed, so re-running always prints the same constants.
//
// Usage: node generate-cip8-test-vector.mjs
//
// Four vectors are produced for the SAME intent hash
// (own_ref = 0x11*32 # 0, buyer_value = {}, seller_value = {}):
//   1. A real CIP-30 `MeshWallet.signData` signature whose protected headers
//      carry the mandatory `alg` + `address` (+ `kid`) entries.
//   2. A raw ed25519 signature over the Sig_structure built with bare
//      `{1: -8}` (`a10127`) protected headers, as emitted by key-in-hand
//      admin tooling.
//   3. A CIP-8 hashed-mode signature: Sig_structure payload is
//      blake2b_224(intent_hash) instead of the intent hash itself, as
//      emitted by hardware wallets that sign with `hashed: true`.
//   4. A NEGATIVE vector signing blake2b_224(blake2b_224(intent_hash))
//      (double-hashed) — the validator accepts exactly one hash level, so
//      this signature must be rejected on-chain.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mOutputReference, serializeData, MeshWallet } from '@meshsdk/core';
import { blake2b } from 'ethereum-cryptography/blake2b.js';
import cbor from 'cbor';

const TEST_TX_ID = '11'.repeat(32);
const OUTPUT_INDEX = 0;

const withdrawalData = {
	alternative: 0,
	fields: [mOutputReference(TEST_TX_ID, OUTPUT_INDEX), new Map(), new Map()],
};
const serialized = serializeData(withdrawalData);
const intentHash = Buffer.from(blake2b(Buffer.from(serialized, 'hex'), 28)).toString('hex');

console.log(`serialized DisputeWithdrawal: ${serialized}`);
console.log(`intent hash (blake2b_224):    ${intentHash}\n`);

function cborByteString(bytes) {
	const length = bytes.length;
	if (length < 24) {
		return Buffer.concat([Buffer.from([0x40 + length]), bytes]);
	}
	if (length < 256) {
		return Buffer.concat([Buffer.from([0x58, length]), bytes]);
	}
	throw new Error('vector generator only supports headers < 256 bytes');
}

function sigStructure(protectedHeadersHex, payloadHex) {
	return Buffer.concat([
		Buffer.from('846a5369676e617475726531', 'hex'),
		cborByteString(Buffer.from(protectedHeadersHex, 'hex')),
		Buffer.from('40', 'hex'),
		cborByteString(Buffer.from(payloadHex, 'hex')),
	]);
}

function blake2b224Hex(hex) {
	return Buffer.from(blake2b(Buffer.from(hex, 'hex'), 28)).toString('hex');
}

// --- Vector 1: real CIP-30 MeshWallet.signData ------------------------------
const wallet = new MeshWallet({
	networkId: 0,
	key: { type: 'mnemonic', words: Array(24).fill('solution') },
});
await wallet.init();
const signed = await wallet.signData(intentHash);
const coseSign1 = cbor.decode(Buffer.from(signed.signature, 'hex'));
const walletProtectedHeaders = Buffer.from(coseSign1[0]).toString('hex');
const walletSignature = Buffer.from(coseSign1[3]).toString('hex');
const coseKey = cbor.decode(Buffer.from(signed.key, 'hex'));
let walletPublicKey = '';
for (const [key, value] of coseKey.entries()) {
	if (Number(key) === -2) {
		walletPublicKey = Buffer.from(value).toString('hex');
	}
}

const walletSigOk = verify(
	null,
	sigStructure(walletProtectedHeaders, intentHash),
	createPublicKey({
		key: Buffer.concat([
			Buffer.from('302a300506032b6570032100', 'hex'),
			Buffer.from(walletPublicKey, 'hex'),
		]),
		format: 'der',
		type: 'spki',
	}),
	Buffer.from(walletSignature, 'hex'),
);

console.log('--- CIP-30 wallet vector ---');
console.log(`cip30_admin_vk:                ${walletPublicKey}`);
console.log(`cip30_admin_vk_hash:           ${blake2b224Hex(walletPublicKey)}`);
console.log(`cip30_protected_headers:       ${walletProtectedHeaders}`);
console.log(`cip30_signature:               ${walletSignature}`);
console.log(`local verification:            ${walletSigOk ? 'OK' : 'FAILED'}\n`);

// --- Vector 2: raw signing with bare {1: -8} headers -------------------------
const RAW_SEED = 'a'.repeat(64);
const rawPrivateKey = createPrivateKey({
	key: Buffer.concat([
		Buffer.from('302e020100300506032b657004220420', 'hex'),
		Buffer.from(RAW_SEED, 'hex'),
	]),
	format: 'der',
	type: 'pkcs8',
});
const rawPublicKey = createPublicKey(rawPrivateKey)
	.export({ format: 'der', type: 'spki' })
	.subarray(-32)
	.toString('hex');
const bareHeaders = 'a10127';
const rawSignature = sign(null, sigStructure(bareHeaders, intentHash), rawPrivateKey).toString('hex');

console.log('--- bare a10127 raw vector ---');
console.log(`raw_admin_vk:                  ${rawPublicKey}`);
console.log(`raw_admin_vk_hash:             ${blake2b224Hex(rawPublicKey)}`);
console.log(`raw_protected_headers:         ${bareHeaders}`);
console.log(`raw_signature:                 ${rawSignature}\n`);

// --- Vector 3: CIP-8 hashed mode (hardware-wallet style) ---------------------
// A wallet in hashed mode signs a Sig_structure whose payload is the
// blake2b_224 hash of the payload it was asked to sign. The `hashed: true`
// flag itself lives in the UNPROTECTED headers (per CIP-8) and is therefore
// neither signed nor submitted on-chain — only the payload bytes differ.
const HASHED_SEED = 'b'.repeat(64);
const hashedPrivateKey = createPrivateKey({
	key: Buffer.concat([
		Buffer.from('302e020100300506032b657004220420', 'hex'),
		Buffer.from(HASHED_SEED, 'hex'),
	]),
	format: 'der',
	type: 'pkcs8',
});
const hashedPublicKey = createPublicKey(hashedPrivateKey)
	.export({ format: 'der', type: 'spki' })
	.subarray(-32)
	.toString('hex');
const hashedPayload = blake2b224Hex(intentHash);
const hashedSignature = sign(
	null,
	sigStructure(bareHeaders, hashedPayload),
	hashedPrivateKey,
).toString('hex');

console.log('--- CIP-8 hashed-mode vector ---');
console.log(`hashed_admin_vk:               ${hashedPublicKey}`);
console.log(`hashed_admin_vk_hash:          ${blake2b224Hex(hashedPublicKey)}`);
console.log(`hashed_protected_headers:      ${bareHeaders}`);
console.log(`hashed_payload (blake2b_224):  ${hashedPayload}`);
console.log(`hashed_signature:              ${hashedSignature}\n`);

// --- Vector 4: NEGATIVE — double-hashed payload ------------------------------
const doubleHashedSignature = sign(
	null,
	sigStructure(bareHeaders, blake2b224Hex(hashedPayload)),
	hashedPrivateKey,
).toString('hex');

console.log('--- double-hashed NEGATIVE vector (must fail on-chain) ---');
console.log(`double_hashed_signature:       ${doubleHashedSignature}`);
