import 'dotenv/config';
import { MeshTxBuilder, resolvePaymentKeyHash } from '@meshsdk/core';
import {
	Action,
	AGENT_WALLET_INDEX,
	assetsPlus,
	blockchainProvider,
	explorerUrl,
	fetchWalletUtxo,
	firstWalletAddress,
	loadSmartWalletScript,
	loadWallet,
	lovelaceAsset,
	lovelaceOf,
	network,
	OWNER_WALLET_INDEX,
	pickCollateral,
	readWalletDatum,
	signWith,
	syncCostModelsFromChain,
	walletDatumData,
} from './example-helpers.mjs';

// Topping up needs no cold key and no quorum: nothing leaves the wallet, so
// there is nothing for co-signers to approve. The agent OR the owner may sign.
const asOwner = process.env.AS_OWNER === '1';

console.log(`Depositing into the smart wallet as the ${asOwner ? 'owner' : 'agent'}`);

await syncCostModelsFromChain();

const signer = loadWallet(asOwner ? OWNER_WALLET_INDEX : AGENT_WALLET_INDEX);
const signerAddress = await firstWalletAddress(signer);
const amount = BigInt(process.env.DEPOSIT_LOVELACE ?? 10_000_000);

const wallet = loadSmartWalletScript();
const utxo = await fetchWalletUtxo(blockchainProvider, wallet);
const datum = readWalletDatum(utxo);

// The datum must come back byte-identical — a deposit may not smuggle a policy
// change in with the money.
const after = assetsPlus(utxo.output.amount, lovelaceAsset(amount));

const signerUtxos = await signer.getUtxos();
const collateral = pickCollateral(signerUtxos);

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
	.spendingPlutusScriptV3()
	.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
	.txInScript(wallet.script.code)
	.txInRedeemerValue({ alternative: Action.Deposit, fields: [] })
	.txInInlineDatumPresent()
	.txOut(wallet.address, after)
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
	.requiredSignerHash(resolvePaymentKeyHash(signerAddress))
	.changeAddress(signerAddress)
	.selectUtxosFrom(signerUtxos)
	.setNetwork(network)
	.complete();

const signedTx = await signWith([signer], unsignedTx);
const txHash = await signer.submitTx(signedTx);

console.log(`Deposit submitted:
    Tx ID: ${txHash}
    View: ${explorerUrl(txHash)}
    Added: ${amount} lovelace
    Wallet balance: ${lovelaceOf(utxo.output.amount)} -> ${lovelaceOf(after)} lovelace
    Signed by: ${asOwner ? 'owner' : 'agent'} only, no quorum
`);
