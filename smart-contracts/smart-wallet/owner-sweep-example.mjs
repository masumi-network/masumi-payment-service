import 'dotenv/config';
import { MeshTxBuilder } from '@meshsdk/core';
import {
	Action,
	assetsMinus,
	blockchainProvider,
	explorerUrl,
	fetchWalletUtxo,
	firstWalletAddress,
	loadSmartWalletScript,
	loadWallet,
	lovelaceOf,
	network,
	OWNER_WALLET_INDEX,
	pickCollateral,
	signWith,
	syncCostModelsFromChain,
} from './example-helpers.mjs';

// Retiring a wallet: sweep the funds and burn the state token in one
// transaction. Burning matters — a swept-but-unburned token is a live
// liability, because whoever holds it can recreate a spendable wallet UTxO at
// the old address under the old quorum.
console.log('Sweeping and retiring the smart wallet as the owner');

await syncCostModelsFromChain();

const owner = loadWallet(OWNER_WALLET_INDEX);
const ownerAddress = await firstWalletAddress(owner);
const payoutAddress = process.env.SWEEP_ADDRESS ?? ownerAddress;

const wallet = loadSmartWalletScript();
const utxo = await fetchWalletUtxo(blockchainProvider, wallet);

// Everything except the token, which is destroyed rather than moved.
const swept = assetsMinus(utxo.output.amount, [{ unit: wallet.stateTokenUnit, quantity: '1' }]);

const ownerUtxos = await owner.getUtxos();
const collateral = pickCollateral(ownerUtxos);

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
	.txInRedeemerValue({ alternative: Action.OwnerSpend, fields: [] })
	.txInInlineDatumPresent()
	.mintPlutusScriptV3()
	.mint('-1', wallet.policyId, wallet.stateTokenUnit.slice(56))
	.mintingScript(wallet.script.code)
	.mintRedeemerValue({ alternative: 0, fields: [] })
	.txOut(payoutAddress, swept)
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
	.setNetwork(network)
	.complete();

const signedTx = await signWith([owner], unsignedTx);
const txHash = await owner.submitTx(signedTx);

console.log(`Wallet retired:
    Tx ID: ${txHash}
    View: ${explorerUrl(txHash)}
    Swept: ${lovelaceOf(swept)} lovelace to ${payoutAddress}
    State token burned — this address is now permanently dead.
    Delete wallet-seed.json before creating a new wallet.
`);
