// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line. Applying PR 729's parameters with `@meshsdk/core@1.9.0-beta.103`
// was measured to derive the same script hash and address as the wallet PR 729
// minted on preprod. See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// Create, locate and retire an agent treasury smart wallet
// (`smart-contracts/smart-wallet`). Spending lives in guarded-lock-builder.ts.
import {
	applyParamsToScript,
	deserializeDatum,
	MeshTxBuilder,
	resolvePaymentKeyHash,
	resolveScriptHash,
	resolveStakeKeyHash,
	resolveTxHash,
	serializePlutusScript,
	type BlockfrostProvider,
	type UTxO,
} from '@meshsdk/core';
import smartWalletPlutus from '../../../../smart-contracts/smart-wallet/plutus.json';
import {
	deriveTotalCollateral,
	getSpendableWalletUtxos,
	lovelaceFromUtxo,
	nativeAssetCount,
	pickBatchCollateral,
} from '../builders/batch-helpers';
import { buildWithEvaluatedBudgets, loadV2ProtocolParameters, type ExUnits } from './guarded-lock-builder';
import {
	assertDeployableWallet,
	assetsMinus,
	parseWalletDatum,
	SmartWalletAction,
	stateTokenName,
	walletDatumData,
	type WalletDatum,
} from './wallet';

const SPEND_VALIDATOR_TITLE = 'smart_wallet.smart_wallet.spend';
const MINT_REDEEMER = { alternative: 0, fields: [] };

export type SmartWalletScript = {
	scriptCode: string;
	address: string;
	policyId: string;
	owner: string;
	stakeKeyHash: string;
	quorumVkhs: string[];
	threshold: number;
};

type MeshNetwork = 'preprod' | 'mainnet';

/**
 * Apply `(owner, quorum_vks, quorum_threshold, stake)` to the compiled
 * validator. The stake credential is the owner's stake key (wayfinder ticket
 * 15), so every wallet under one configuration shares one base address.
 */
export function loadSmartWalletScript(params: {
	ownerAddress: string;
	quorumVkhs: string[];
	threshold: number;
	network: MeshNetwork;
}): SmartWalletScript {
	const validator = smartWalletPlutus.validators.find((entry) => entry.title === SPEND_VALIDATOR_TITLE);
	if (validator == null) {
		throw new Error(`${SPEND_VALIDATOR_TITLE} is missing from smart-contracts/smart-wallet/plutus.json`);
	}
	const owner = resolvePaymentKeyHash(params.ownerAddress);
	const stakeKeyHash = resolveStakeKeyHash(params.ownerAddress);
	const scriptCode = applyParamsToScript(validator.compiledCode, [
		owner,
		params.quorumVkhs,
		params.threshold,
		// Option<Credential>: Some(VerificationKey(stake key hash))
		{ alternative: 0, fields: [{ alternative: 0, fields: [stakeKeyHash] }] },
	]);
	const serialized: { address: unknown } = serializePlutusScript(
		{ code: scriptCode, version: 'V3' },
		stakeKeyHash,
		params.network === 'mainnet' ? 1 : 0,
	);
	if (typeof serialized.address !== 'string') {
		throw new TypeError(`Expected serializePlutusScript to return a string address, got ${typeof serialized.address}`);
	}
	return {
		scriptCode,
		address: serialized.address,
		policyId: resolveScriptHash(scriptCode, 'V3'),
		owner,
		stakeKeyHash,
		quorumVkhs: params.quorumVkhs,
		threshold: params.threshold,
	};
}

export function readWalletDatum(utxo: UTxO): WalletDatum {
	if (!utxo.output.plutusData) {
		throw new Error(`Wallet UTxO ${utxo.input.txHash}#${utxo.input.outputIndex} carries no inline datum`);
	}
	return parseWalletDatum(deserializeDatum(utxo.output.plutusData));
}

/**
 * The wallet is found by its state token, never by scanning for a datum shape
 * an attacker could imitate. Exactly one UTxO may carry the token.
 */
export async function fetchWalletUtxo(
	provider: Pick<BlockfrostProvider, 'fetchAddressUTxOs'>,
	wallet: Pick<SmartWalletScript, 'address' | 'policyId'>,
	tokenName: string,
): Promise<UTxO> {
	const unit = `${wallet.policyId}${tokenName}`;
	const utxos = await provider.fetchAddressUTxOs(wallet.address);
	const held = utxos.filter((utxo) =>
		utxo.output.amount.some((asset) => asset.unit === unit && BigInt(asset.quantity) === 1n),
	);
	if (held.length !== 1) {
		throw new Error(`Expected exactly one UTxO carrying ${unit} at ${wallet.address}, found ${held.length}`);
	}
	return held[0];
}

function pickOwnerCollateral(ownerUtxos: UTxO[], exclude: Array<{ txHash: string; outputIndex: number }>): UTxO {
	const collateral = pickBatchCollateral(ownerUtxos, exclude);
	if (collateral == null) {
		throw new Error('the owner key holds no key-locked UTxO of at least 5 ADA to lend as collateral');
	}
	return collateral;
}

function totalCollateral(budgets: ExUnits[], protocolParameters: unknown, collateral: UTxO): string {
	return deriveTotalCollateral(budgets, protocolParameters, lovelaceFromUtxo(collateral), nativeAssetCount(collateral));
}

export type MintWalletBuild = {
	unsignedTx: string;
	txHash: string;
	seed: { txHash: string; outputIndex: number };
	tokenName: string;
	stateTokenUnit: string;
};

/**
 * Mint the state token and fund the wallet in one owner-signed transaction.
 * The seed UTxO is consumed here, which is what makes the token name unique.
 */
export async function buildMintWalletTx(params: {
	provider: BlockfrostProvider;
	rpcApiKey: string;
	network: MeshNetwork;
	wallet: SmartWalletScript;
	ownerAddress: string;
	ownerUtxos: UTxO[];
	datum: WalletDatum;
	fundLovelace: bigint;
}): Promise<MintWalletBuild> {
	const { provider, network, wallet, ownerAddress, ownerUtxos, datum, fundLovelace } = params;
	if (resolvePaymentKeyHash(ownerAddress) !== wallet.owner) {
		throw new Error('ownerAddress does not belong to the wallet owner key');
	}
	assertDeployableWallet({
		owner: wallet.owner,
		quorumVkhs: wallet.quorumVkhs,
		threshold: wallet.threshold,
		datum,
		fundLovelace,
	});

	const protocolParameters = await loadV2ProtocolParameters(provider, params.rpcApiKey);
	const collateral = pickOwnerCollateral(ownerUtxos, []);
	const refKey = (utxo: UTxO) => `${utxo.input.txHash}#${utxo.input.outputIndex}`;
	// Seed and collateral may coincide: the seed is a key input, which CIP-40
	// allows in both input sets. Prefer a separate one when the owner has it.
	const seedUtxo = [...ownerUtxos]
		.filter((utxo) => ownerUtxos.length === 1 || refKey(utxo) !== refKey(collateral))
		.sort((a, b) =>
			lovelaceFromUtxo(b) > lovelaceFromUtxo(a) ? 1 : lovelaceFromUtxo(b) < lovelaceFromUtxo(a) ? -1 : 0,
		)[0];
	const seed = { txHash: seedUtxo.input.txHash, outputIndex: seedUtxo.input.outputIndex };
	const tokenName = stateTokenName(seed);
	const stateTokenUnit = `${wallet.policyId}${tokenName}`;

	const { tx } = await buildWithEvaluatedBudgets(provider, ['MINT'], async (budgets) => {
		const mint = budgets.get('MINT');
		if (mint == null) throw new Error('missing MINT budget');
		const txBuilder = new MeshTxBuilder({ fetcher: provider });
		txBuilder.protocolParams(protocolParameters);
		return await txBuilder
			.txIn(seedUtxo.input.txHash, seedUtxo.input.outputIndex, seedUtxo.output.amount, seedUtxo.output.address, 0)
			.mintPlutusScriptV3()
			.mint('1', wallet.policyId, tokenName)
			.mintingScript(wallet.scriptCode)
			.mintRedeemerValue(MINT_REDEEMER, 'Mesh', mint)
			.txOut(wallet.address, [
				{ unit: 'lovelace', quantity: fundLovelace.toString() },
				{ unit: stateTokenUnit, quantity: '1' },
			])
			.txOutInlineDatumValue(walletDatumData(datum))
			.txInCollateral(
				collateral.input.txHash,
				collateral.input.outputIndex,
				collateral.output.amount,
				collateral.output.address,
			)
			.setTotalCollateral(totalCollateral([mint], protocolParameters, collateral))
			// The mint is owner-gated; declaring the signer is what puts it in extra_signatories.
			.requiredSignerHash(wallet.owner)
			.selectUtxosFrom(getSpendableWalletUtxos(ownerUtxos, collateral))
			.changeAddress(ownerAddress)
			.setNetwork(network)
			.complete();
	});

	return { unsignedTx: tx, txHash: resolveTxHash(tx), seed, tokenName, stateTokenUnit };
}

/**
 * Retire a wallet: `OwnerSpend` sweeps everything to `payoutAddress` and the
 * state token is burned in the same transaction. A swept but unburned token
 * could recreate a spendable wallet at the old address, so the two never split.
 */
export async function buildOwnerSweepTx(params: {
	provider: BlockfrostProvider;
	rpcApiKey: string;
	network: MeshNetwork;
	wallet: SmartWalletScript;
	walletUtxo: UTxO;
	tokenName: string;
	ownerAddress: string;
	ownerUtxos: UTxO[];
	payoutAddress: string;
}): Promise<{ unsignedTx: string; txHash: string }> {
	const { provider, network, wallet, walletUtxo, tokenName, ownerAddress, ownerUtxos, payoutAddress } = params;
	if (resolvePaymentKeyHash(ownerAddress) !== wallet.owner) {
		throw new Error('ownerAddress does not belong to the wallet owner key');
	}
	const stateTokenUnit = `${wallet.policyId}${tokenName}`;
	const swept = assetsMinus(walletUtxo.output.amount, [{ unit: stateTokenUnit, quantity: '1' }]);
	const protocolParameters = await loadV2ProtocolParameters(provider, params.rpcApiKey);
	const collateral = pickOwnerCollateral(ownerUtxos, [walletUtxo.input]);

	const { tx } = await buildWithEvaluatedBudgets(provider, ['SPEND', 'MINT'], async (budgets) => {
		const spend = budgets.get('SPEND');
		const mint = budgets.get('MINT');
		if (spend == null || mint == null) throw new Error('missing SPEND or MINT budget');
		const txBuilder = new MeshTxBuilder({ fetcher: provider });
		txBuilder.protocolParams(protocolParameters);
		return await txBuilder
			.spendingPlutusScript('V3')
			.txIn(
				walletUtxo.input.txHash,
				walletUtxo.input.outputIndex,
				walletUtxo.output.amount,
				walletUtxo.output.address,
				0,
			)
			.txInScript(wallet.scriptCode)
			.txInRedeemerValue({ alternative: SmartWalletAction.OwnerSpend, fields: [] }, 'Mesh', spend)
			.txInInlineDatumPresent()
			.mintPlutusScriptV3()
			.mint('-1', wallet.policyId, tokenName)
			.mintingScript(wallet.scriptCode)
			.mintRedeemerValue(MINT_REDEEMER, 'Mesh', mint)
			.txOut(payoutAddress, swept)
			.txInCollateral(
				collateral.input.txHash,
				collateral.input.outputIndex,
				collateral.output.amount,
				collateral.output.address,
			)
			.setTotalCollateral(totalCollateral([spend, mint], protocolParameters, collateral))
			.requiredSignerHash(wallet.owner)
			.selectUtxosFrom(getSpendableWalletUtxos(ownerUtxos, collateral))
			.changeAddress(ownerAddress)
			.setNetwork(network)
			.complete();
	});

	return { unsignedTx: tx, txHash: resolveTxHash(tx) };
}
