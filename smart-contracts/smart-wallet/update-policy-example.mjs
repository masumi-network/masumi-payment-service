import 'dotenv/config';
import { MeshTxBuilder, resolvePaymentKeyHash } from '@meshsdk/core';
import {
	Action,
	assetValueData,
	blockchainProvider,
	explorerUrl,
	fetchWalletUtxo,
	firstWalletAddress,
	loadSmartWalletScript,
	loadWallet,
	network,
	OWNER_WALLET_INDEX,
	pickCollateral,
	readAddress,
	readWalletDatum,
	resolveValidity,
	signWith,
	syncCostModelsFromChain,
	walletDatumData,
} from './example-helpers.mjs';

// The cold key rewrites the dynamic configuration in place. The address, the
// state token and the balance all stay — only the datum changes. This is how a
// compromised hot key is revoked: rotating the agent costs one transaction,
// where rotating a co-signer would mean a whole new wallet.
console.log('Rewriting the wallet policy as the owner');

await syncCostModelsFromChain();

const owner = loadWallet(OWNER_WALLET_INDEX);
const ownerAddress = await firstWalletAddress(owner);

const wallet = loadSmartWalletScript();
const utxo = await fetchWalletUtxo(blockchainProvider, wallet);
const datum = readWalletDatum(utxo);

const newAgent = process.env.NEW_AGENT_KEY_HASH
	? process.env.NEW_AGENT_KEY_HASH
	: process.env.ROTATE_AGENT_TO
		? resolvePaymentKeyHash(readAddress(Number(process.env.ROTATE_AGENT_TO)))
		: datum.agent;

const newLimit = process.env.DAILY_LIMIT_LOVELACE
	? assetValueData([{ unit: 'lovelace', quantity: process.env.DAILY_LIMIT_LOVELACE }])
	: datum.limit;

// Counters must keep the same shape as the limit, so reset them alongside any
// change to the asset list. Getting this wrong brings every later agent spend
// down on the shape check, with no on-chain feedback at the moment of the edit.
const newSpent = process.env.DAILY_LIMIT_LOVELACE
	? assetValueData([{ unit: 'lovelace', quantity: '0' }])
	: datum.spentInPeriod;

const updated = {
	...datum,
	agent: newAgent,
	limit: newLimit,
	spentInPeriod: newSpent,
	minBalanceLovelace: process.env.MIN_BALANCE_LOVELACE
		? BigInt(process.env.MIN_BALANCE_LOVELACE)
		: datum.minBalanceLovelace,
};

const ownerUtxos = await owner.getUtxos();
const collateral = pickCollateral(ownerUtxos);
const validity = resolveValidity();

const unsignedTx = await new MeshTxBuilder({
	fetcher: blockchainProvider,
	submitter: blockchainProvider,
	// Without an evaluator, mesh stamps every redeemer with its DEFAULT budget
	// and prices the fee off that ceiling — the tx works but overpays. With it,
	// .complete() measures real execution units, matching the repo's builders
	// (evaluateTx -> per-redeemer budgets -> deriveTotalCollateral).
	evaluator: blockchainProvider,
	verbose: false,
})
	.spendingPlutusScriptV3()
	.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
	.txInScript(wallet.script.code)
	.txInRedeemerValue({ alternative: Action.UpdatePolicy, fields: [] })
	.txInInlineDatumPresent()
	.txOut(wallet.address, utxo.output.amount)
	.txOutInlineDatumValue(walletDatumData(updated))
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
	.requiredSignerHash(wallet.owner)
	.changeAddress(ownerAddress)
	.selectUtxosFrom(ownerUtxos)
	.invalidBefore(validity.invalidBefore)
	.invalidHereafter(validity.invalidAfter)
	.setNetwork(network)
	.complete();

const signedTx = await signWith([owner], unsignedTx);
const txHash = await owner.submitTx(signedTx);

console.log(`Policy updated:
    Tx ID: ${txHash}
    View: ${explorerUrl(txHash)}
    Agent: ${datum.agent} -> ${updated.agent}
    Address unchanged: ${wallet.address}
`);
