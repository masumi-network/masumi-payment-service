import 'dotenv/config';
import fs from 'node:fs';
import { MeshTxBuilder, resolvePaymentKeyHash } from '@meshsdk/core';
import {
	AGENT_WALLET_INDEX,
	stateTokenName,
	assetValueData,
	blockchainProvider,
	explorerUrl,
	firstWalletAddress,
	hasSeed,
	loadSmartWalletScript,
	loadWallet,
	lovelaceOf,
	network,
	OWNER_WALLET_INDEX,
	pickCollateral,
	readAddress,
	syncCostModelsFromChain,
	walletDatumData,
	writeSeed,
} from './example-helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

console.log('Creating a smart wallet: minting its state token and funding it');

if (hasSeed() && process.env.FORCE_NEW !== '1') {
	throw new Error('wallet-seed.json already exists. Sweep the old wallet first, or set FORCE_NEW=1.');
}

await syncCostModelsFromChain();

const owner = loadWallet(OWNER_WALLET_INDEX);
const ownerAddress = await firstWalletAddress(owner);
const utxos = await owner.getUtxos();
if (utxos.length === 0) {
	throw new Error('Owner wallet has no UTxOs. Fund it from the preprod faucet first.');
}

// The seed is a script parameter, so picking it *is* choosing the wallet's
// address. It must be consumed by this very transaction — that is the one-shot
// guarantee: the ledger will never allow it to be spent again.
//
// Seed and collateral may be the same UTxO here. This transaction spends no
// script input, only mints, and CIP-40 permits a key-locked UTxO to appear in
// both `inputs` and `collateral_inputs` — which is what lets the demo run off a
// single faucet payment. The registry minting paths rely on the same rule.
const collateral = pickCollateral(utxos);
const others = utxos.filter(
	(utxo) =>
		utxo.input.txHash !== collateral.input.txHash || utxo.input.outputIndex !== collateral.input.outputIndex,
);
const seedUtxo = (others.length > 0 ? others : utxos).sort(
	(a, b) => Number(lovelaceOf(b.output.amount) - lovelaceOf(a.output.amount)),
)[0];
const seed = { txHash: seedUtxo.input.txHash, outputIndex: seedUtxo.input.outputIndex };

const tokenName = stateTokenName(seed);
const wallet = loadSmartWalletScript(seed);
const fundLovelace = process.env.FUND_LOVELACE ?? '60000000';

const now = Date.now();
const datum = {
	agent: resolvePaymentKeyHash(readAddress(AGENT_WALLET_INDEX)),
	// Lovelace MUST be listed, or the wallet can neither spend nor receive ADA.
	limit: assetValueData([{ unit: 'lovelace', quantity: process.env.DAILY_LIMIT_LOVELACE ?? '20000000' }]),
	periodLength: BigInt(process.env.PERIOD_MS ?? DAY_MS),
	periodStart: BigInt(process.env.PERIOD_START_MS ?? now),
	spentInPeriod: assetValueData([{ unit: 'lovelace', quantity: '0' }]),
	minBalanceLovelace: BigInt(process.env.MIN_BALANCE_LOVELACE ?? 5_000_000),
};

const txBuilder = new MeshTxBuilder({
	fetcher: blockchainProvider,
	submitter: blockchainProvider,
	// Without an evaluator, mesh stamps every redeemer with its DEFAULT budget
	// and prices the fee off that ceiling — the tx works but overpays. With it,
	// .complete() measures real execution units, matching the repo's builders
	// (evaluateTx -> per-redeemer budgets -> deriveTotalCollateral).
	evaluator: blockchainProvider,
	verbose: false,
});

const unsignedTx = await txBuilder
	.txIn(seedUtxo.input.txHash, seedUtxo.input.outputIndex, seedUtxo.output.amount, seedUtxo.output.address)
	.mintPlutusScriptV3()
	.mint('1', wallet.policyId, tokenName)
	.mintingScript(wallet.script.code)
	.mintRedeemerValue({ alternative: 0, fields: [] })
	.txOut(wallet.address, [
		{ unit: 'lovelace', quantity: fundLovelace },
		{ unit: wallet.stateTokenUnit, quantity: '1' },
	])
	.txOutInlineDatumValue(walletDatumData(datum))
	.txInCollateral(
		collateral.input.txHash,
		collateral.input.outputIndex,
		collateral.output.amount,
		collateral.output.address,
	)
	// Mesh only emits the ledger-required `collateral_return` when total
	// collateral is declared — and without that return, mixed-asset collateral is
	// rejected outright with `CollateralContainsNonADA`. The preprod faucet hands
	// out ADA bundled with tUSDM, so this is the common case, not the exotic one.
	.setTotalCollateral('5000000')
	// The mint is owner-gated; declaring the signer is what puts the owner into
	// extra_signatories — signing alone does not.
	.requiredSignerHash(wallet.owner)
	.changeAddress(ownerAddress)
	.selectUtxosFrom(utxos)
	.setNetwork(network)
	.complete();

// Persist the seed BEFORE submitting: if the process dies between a
// successful submit and the write, the token exists on-chain but nothing
// records which seed named it — the wallet would be identifiable only by
// trawling the owner's transaction history. A stale file from a FAILED submit
// is removed below so the hasSeed() guard cannot wedge a retry.
writeSeed(seed);
const signedTx = await owner.signTx(unsignedTx);
let txHash;
try {
	txHash = await owner.submitTx(signedTx);
} catch (error) {
	fs.rmSync('wallet-seed.json', { force: true });
	throw error;
}

console.log(`Smart wallet created:
    Tx ID: ${txHash}
    View: ${explorerUrl(txHash)}
    Wallet address: ${wallet.address}
    Policy id (= script hash): ${wallet.policyId}
    State token: ${wallet.stateTokenUnit}
    Seed: ${seed.txHash}#${seed.outputIndex}  (saved to wallet-seed.json — keep it)
    Owner: ${wallet.owner}
    Agent: ${datum.agent}
    Quorum: ${wallet.threshold} of ${wallet.quorum.length}
    Funded: ${fundLovelace} lovelace
`);
