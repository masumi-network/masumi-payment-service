import 'dotenv/config';
import { MeshTxBuilder, resolvePaymentKeyHash } from '@meshsdk/core';
import {
	Action,
	AGENT_WALLET_INDEX,
	applyAgentSpend,
	assetsMinus,
	assetValueEntries,
	assetValueGet,
	blockchainProvider,
	COSIGNER_WALLET_INDEXES,
	explorerUrl,
	fetchWalletUtxo,
	firstWalletAddress,
	loadSmartWalletScript,
	loadWallet,
	lovelaceAsset,
	lovelaceOf,
	network,
	outflowOf,
	pickCollateral,
	readAddress,
	readWalletDatum,
	RECIPIENT_WALLET_INDEX,
	resolveValidity,
	signWith,
	syncCostModelsFromChain,
	walletDatumData,
} from './example-helpers.mjs';

console.log('Spending from the smart wallet: agent plus quorum');

await syncCostModelsFromChain();

const agent = loadWallet(AGENT_WALLET_INDEX);
const agentAddress = await firstWalletAddress(agent);
const recipient = process.env.RECIPIENT_ADDRESS ?? readAddress(RECIPIENT_WALLET_INDEX);
const payout = BigInt(process.env.PAYOUT_LOVELACE ?? 3_000_000);

const wallet = loadSmartWalletScript();
const utxo = await fetchWalletUtxo(blockchainProvider, wallet);
const datum = readWalletDatum(utxo);
const validity = resolveValidity();

// The agent pays the fee from its own inputs, so the wallet's outflow is
// exactly the payout. Everything else — including the state token, which the
// validator freezes in place — stays on the continuing output.
const remaining = assetsMinus(utxo.output.amount, lovelaceAsset(payout));
if (lovelaceOf(remaining) < datum.minBalanceLovelace) {
	throw new Error(
		`Payout would leave ${lovelaceOf(remaining)} lovelace, below the floor of ${datum.minBalanceLovelace}`,
	);
}

const outflow = outflowOf(utxo.output.amount, remaining);
const nextDatum = applyAgentSpend(datum, outflow, validity);

// Only co-signers who are actually in the quorum count, and the agent's own key
// never does — so gather exactly the threshold from the configured set.
const agentKeyHash = resolvePaymentKeyHash(agentAddress);
const cosigners = [];
for (const index of COSIGNER_WALLET_INDEXES) {
	const keyHash = resolvePaymentKeyHash(readAddress(index));
	if (keyHash !== agentKeyHash && wallet.quorum.includes(keyHash) && cosigners.length < wallet.threshold) {
		cosigners.push({ wallet: loadWallet(index), keyHash });
	}
}
if (cosigners.length < wallet.threshold) {
	throw new Error(`Need ${wallet.threshold} co-signers from the quorum, found ${cosigners.length}`);
}

const agentUtxos = await agent.getUtxos();
const collateral = pickCollateral(agentUtxos);

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

txBuilder
	.spendingPlutusScriptV3()
	.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
	.txInScript(wallet.script.code)
	.txInRedeemerValue({ alternative: Action.AgentSpend, fields: [] })
	.txInInlineDatumPresent()
	.txOut(wallet.address, remaining)
	.txOutInlineDatumValue(walletDatumData(nextDatum))
	.txOut(recipient, lovelaceAsset(payout))
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
	.requiredSignerHash(agentKeyHash)
	.changeAddress(agentAddress)
	.selectUtxosFrom(agentUtxos)
	.invalidBefore(validity.invalidBefore)
	.invalidHereafter(validity.invalidAfter)
	.setNetwork(network);

for (const cosigner of cosigners) {
	txBuilder.requiredSignerHash(cosigner.keyHash);
}

const unsignedTx = await txBuilder.complete();
const signedTx = await signWith([agent, ...cosigners.map((entry) => entry.wallet)], unsignedTx);
const txHash = await agent.submitTx(signedTx);

const spent = assetValueGet(nextDatum.spentInPeriod, '', '') ?? 0n;
const allowed = assetValueGet(nextDatum.limit, '', '') ?? 0n;

console.log(`Agent spend submitted:
    Tx ID: ${txHash}
    View: ${explorerUrl(txHash)}
    Paid: ${payout} lovelace to ${recipient}
    Signed by: agent + ${cosigners.length} of ${wallet.quorum.length} co-signers
    Budget used: ${spent} / ${allowed} lovelace in the window from ${nextDatum.periodStart}
    Wallet balance left: ${lovelaceOf(remaining)} lovelace
    Assets tracked: ${assetValueEntries(nextDatum.limit).length}
`);
