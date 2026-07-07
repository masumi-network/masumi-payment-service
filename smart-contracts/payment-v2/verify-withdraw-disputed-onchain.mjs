// End-to-end preprod verification: lock a fake Disputed UTxO, build
// WithdrawDisputed with real CIP-30 MeshWallet.signData admin signatures,
// evaluateTx against Koios, then submit unless EVALUATE_ONLY=1.
//
// Signature coverage: admin 1 signs raw mode (payload = intent hash), admin 2
// signs CIP-8 hashed mode (payload = blake2b_224(intent hash)), so a single
// settlement exercises both on-chain verification branches.
//
// Prerequisites:
//   pnpm install && pnpm run generate-wallet
//   Fund wallet_1 (buyer) and wallet_3/4 (admins) on preprod.
//
// Usage:
//   pnpm run verify-onchain
//   EVALUATE_ONLY=1 pnpm run verify-onchain   # evaluate only, no submit
import 'dotenv/config';
import { Transaction } from '@meshsdk/core';
import {
	Action,
	actionData,
	adminSignatureData,
	applyValidity,
	assetsMinusLovelace,
	assetsToAssetValueData,
	blake2b224,
	blockchainProvider,
	disputeIntentHash,
	firstWalletAddress,
	hasAssets,
	loadPaymentScript,
	loadWallet,
	lovelaceAsset,
	network,
	readAddress,
	syncCostModelsFromChain,
	taggedRecipient,
} from './example-helpers.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const MIN_BUYER_LOVELACE = 15_000_000n;
const FUND_TRANSFER_LOVELACE = '20000000';
const evaluateOnly = process.env.EVALUATE_ONLY === '1';

function requireWalletSk(index) {
	const path = `wallet_${index}.sk`;
	if (!fs.existsSync(path)) {
		throw new Error(`${path} missing — run pnpm run generate-wallet first`);
	}
}

async function lovelaceAt(address) {
	const utxos = await blockchainProvider.fetchAddressUTxOs(address);
	return utxos.reduce((sum, utxo) => {
		const lovelace = utxo.output.amount.find((a) => a.unit === 'lovelace');
		return sum + BigInt(lovelace?.quantity ?? 0);
	}, 0n);
}

// Koios only sees a tx once it is in a block, so poll instead of fetching
// right after submit (fixed 45s waits are flaky on slow preprod blocks).
async function waitForUtxos(address, isMatch, label, timeoutMs = 300_000) {
	const startedAt = Date.now();
	for (;;) {
		const utxos = (await blockchainProvider.fetchAddressUTxOs(address)).filter(isMatch);
		if (utxos.length > 0) {
			return utxos;
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} at ${address}`);
		}
		console.log(`  waiting for ${label} to confirm...`);
		await new Promise((resolve) => setTimeout(resolve, 15_000));
	}
}

async function ensureBuyerFunded(buyerWallet, funderWallet) {
	const buyerAddress = await firstWalletAddress(buyerWallet);
	const balance = await lovelaceAt(buyerAddress);
	if (balance >= MIN_BUYER_LOVELACE) {
		console.log(`wallet_1 balance OK (${balance} lovelace)`);
		return buyerAddress;
	}
	console.log(`wallet_1 underfunded (${balance}); sending ${FUND_TRANSFER_LOVELACE} lovelace from wallet_3`);
	await syncCostModelsFromChain();
	let tx = new Transaction({ initiator: funderWallet, fetcher: blockchainProvider })
		.sendLovelace({ address: buyerAddress }, FUND_TRANSFER_LOVELACE)
		.setChangeAddress(await firstWalletAddress(funderWallet))
		.setNetwork(network);
	const unsigned = await tx.build();
	const signed = await funderWallet.signTx(unsigned);
	const fundTxHash = await funderWallet.submitTx(signed);
	console.log(`Funding tx submitted: ${fundTxHash} — waiting for confirmation`);
	await waitForUtxos(buyerAddress, (u) => u.input.txHash === fundTxHash, 'buyer funding tx');
	return buyerAddress;
}

console.log('=== V2 WithdrawDisputed on-chain verification (CIP-30 admin signatures) ===\n');

for (const index of [1, 2, 3, 4]) {
	requireWalletSk(index);
}

console.log('Running aiken check (local validator tests including CIP-30 ed25519 vectors)...');
execSync('aiken check', { stdio: 'inherit' });

await syncCostModelsFromChain();

const buyerWallet = loadWallet(1);
const adminWallet1 = loadWallet(3);
const adminWallet2 = loadWallet(4);
const funderWallet = loadWallet(3);

await ensureBuyerFunded(buyerWallet, funderWallet);

console.log('\nLocking fake Disputed UTxO via lock-fake-disputed.mjs ...');
// Capture (don't inherit) stdout so we can pin the EXACT lock we just created.
// The script address accumulates stale datum-bearing UTxOs from earlier runs,
// so selecting the first plutusData UTxO would non-deterministically settle a
// stale lock — flaky verification. lock-fake-disputed.mjs always locks at
// output index 0 and prints `Tx ID: <hash>`; parse it and match that ref.
const lockOutput = execSync('node lock-fake-disputed.mjs', {
	encoding: 'utf8',
	env: { ...process.env, LOCK_LOVELACE: '10000000' },
});
process.stdout.write(lockOutput);
const lockTxHashMatch = lockOutput.match(/Tx ID:\s*([0-9a-fA-F]{64})/);
if (lockTxHashMatch == null) {
	throw new Error('Could not parse the lock tx hash from lock-fake-disputed.mjs output');
}
const lockTxHash = lockTxHashMatch[1];
console.log(`Pinned lock tx: ${lockTxHash}#0`);

const { script, scriptAddress } = loadPaymentScript();
const buyerAddress = readAddress(1);
const sellerAddress = readAddress(2);
const feePayerAddress = await firstWalletAddress(adminWallet1);

const disputed = await waitForUtxos(
	scriptAddress,
	(u) => u.output.plutusData && u.input.txHash === lockTxHash && u.input.outputIndex === 0,
	'fake Disputed lock',
);
const utxo = disputed[0];
console.log(`Using contract UTxO ${utxo.input.txHash}#${utxo.input.outputIndex}`);

const buyerLovelace = 2_000_000n;
const buyerAssets = lovelaceAsset(buyerLovelace);
const sellerAssets = assetsMinusLovelace(utxo.output.amount, buyerLovelace);
const buyerValueData = assetsToAssetValueData(buyerAssets);
const sellerValueData = assetsToAssetValueData(sellerAssets);
const intentHash = disputeIntentHash(utxo, buyerValueData, sellerValueData);

console.log(`Intent hash: ${intentHash}`);
// Admin 2 signs CIP-8 hashed mode: `signData` over the pre-hashed payload
// yields signed bytes identical to a hardware wallet with `hashed: true`
// (the flag sits in the unprotected headers, which are neither signed nor
// submitted on-chain), exercising the validator's hashed fallback branch.
const adminSignatures = [
	await adminSignatureData(adminWallet1, intentHash),
	await adminSignatureData(adminWallet2, blake2b224(intentHash)),
];

let tx = new Transaction({ initiator: adminWallet1, fetcher: blockchainProvider }).redeemValue({
	value: utxo,
	script,
	redeemer: actionData(Action.WithdrawDisputed, [buyerValueData, sellerValueData, adminSignatures]),
});

if (hasAssets(buyerAssets)) {
	tx = tx.sendAssets(taggedRecipient(buyerAddress, utxo), buyerAssets);
}
if (hasAssets(sellerAssets)) {
	tx = tx.sendAssets(taggedRecipient(sellerAddress, utxo), sellerAssets);
}

tx = tx.setChangeAddress(feePayerAddress).setRequiredSigners([feePayerAddress]);
await applyValidity(tx);

const unsignedTx = await tx.build();
const evaluation = await blockchainProvider.evaluateTx(unsignedTx);
const spendBudgets = evaluation.filter((entry) => entry.tag === 'SPEND');
if (spendBudgets.length === 0) {
	throw new Error(`evaluateTx returned no SPEND budget — script rejected: ${JSON.stringify(evaluation)}`);
}
console.log('\nevaluateTx SPEND budgets:', spendBudgets);

if (evaluateOnly) {
	console.log('\nEVALUATE_ONLY=1 — ledger accepted the script; skipping submit.');
	process.exit(0);
}

const signedTx = await adminWallet1.signTx(unsignedTx);
const txHash = await adminWallet1.submitTx(signedTx);
console.log(`\nWithdrawDisputed submitted and accepted by evaluateTx:
  Tx ID: ${txHash}
  View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
  Script: ${scriptAddress}
`);
