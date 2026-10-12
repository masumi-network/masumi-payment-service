import { BlockfrostProvider, MeshTxBuilder, MeshWallet, resolveTxHash, type UTxO } from '@meshsdk/core';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { syncMeshCostModelsFromHeadV2, type HeadRawCostModels } from '../utils/mesh-cost-model-sync';
import type { GuardedWalletParams } from './guarded-wallet';
import { SmartWalletAction } from './wallet';
import { fetchWalletUtxo, loadSmartWalletScript, type SmartWalletScript } from './wallet-lifecycle';

/**
 * Owner-signed transactions that move a guarded wallet into and out of a Hydra
 * head. Both spend the wallet with `OwnerSpend`, which needs only the owner's
 * signature, so the owner key stays off the node and signs each move.
 *
 * Inside the head the wallet keeps its address, value, state token and datum:
 * the deposit records the original output and the head recreates it, and the
 * decommit pays it back to L1 unchanged.
 */

type MeshNetwork = 'preprod' | 'mainnet';

/**
 * Declared budget for one wallet script spend inside a head. The head charges no
 * fee and has no evaluator endpoint, so a generous fixed budget costs nothing. It
 * must stay below the head's `maxTxExecutionUnits` (16.5M mem, 10B steps).
 */
/**
 * A decommit the head accepts leaves the snapshot within seconds. A withdraw whose
 * wallet UTxO is still in the head after this was rejected (DecommitInvalid).
 */
export const WITHDRAW_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A deposit tx can land in the last slot before signBefore while the L1 index
 * still shows the wallet at its address. After this grace it is on chain or lost.
 */
export const DEPOSIT_L1_GRACE_MS = 10 * 60 * 1000;

export const L2_WALLET_SPEND_EX_UNITS = { mem: 10_000_000, steps: 5_000_000_000 };

// Placeholder only: hydra-node re-estimates the deposit's ExUnits while it balances.
const BLUEPRINT_EX_UNITS = { mem: 1_000_000, steps: 500_000_000 };

/**
 * The blueprint hydra-node turns into a deposit: the wallet input under
 * `OwnerSpend` and the owner as required signer, with no outputs. The node adds
 * the deposit output, its own fee input, collateral and change, and recomputes
 * the script integrity hash.
 */
export function buildOwnerDepositBlueprint(params: {
	script: SmartWalletScript;
	walletUtxo: UTxO;
	network: MeshNetwork;
}): string {
	const { script, walletUtxo } = params;
	return new MeshTxBuilder()
		.spendingPlutusScript('V3')
		.txIn(walletUtxo.input.txHash, walletUtxo.input.outputIndex, walletUtxo.output.amount, walletUtxo.output.address, 0)
		.txInScript(script.scriptCode)
		.txInRedeemerValue({ alternative: SmartWalletAction.OwnerSpend, fields: [] }, 'Mesh', BLUEPRINT_EX_UNITS)
		.txInInlineDatumPresent()
		.requiredSignerHash(script.owner)
		.setNetwork(params.network)
		.completeUnbalanced();
}

/**
 * The in-head transaction a decommit sends to L1: the wallet input under
 * `OwnerSpend` and one output that recreates it exactly (same address, value and
 * inline datum). The collateral is a plain in-head UTxO of the agent hot wallet,
 * so the agent signs as well as the owner.
 *
 * The head checks the script integrity hash against its own cost models, so they
 * are synced into the V2 mesh line first, under the process-wide cost-model lock
 * that also covers the build.
 */
export async function buildOwnerDecommitTx(params: {
	script: SmartWalletScript;
	walletUtxo: UTxO;
	collateral: UTxO;
	headCostModels: HeadRawCostModels;
	network: MeshNetwork;
}): Promise<{ unsignedTx: string; txHash: string }> {
	const { script, walletUtxo, collateral } = params;
	if (!hasInlineDatum(walletUtxo)) {
		throw new Error(`Wallet UTxO ${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex} carries no inline datum`);
	}
	const unsignedTx = await withMeshCostModelLock('hydra', async () => {
		await syncMeshCostModelsFromHeadV2(params.headCostModels);
		return buildDecommitBody(script, walletUtxo, collateral, params.network);
	});
	return { unsignedTx, txHash: resolveTxHash(unsignedTx) };
}

function buildDecommitBody(
	script: SmartWalletScript,
	walletUtxo: UTxO & { output: { plutusData: string } },
	collateral: UTxO,
	network: MeshNetwork,
): string {
	const builder = new MeshTxBuilder({ isHydra: true });
	builder.setFee('0');
	return (
		builder
			.spendingPlutusScript('V3')
			.txIn(
				walletUtxo.input.txHash,
				walletUtxo.input.outputIndex,
				walletUtxo.output.amount,
				walletUtxo.output.address,
				0,
			)
			.txInScript(script.scriptCode)
			.txInRedeemerValue({ alternative: SmartWalletAction.OwnerSpend, fields: [] }, 'Mesh', L2_WALLET_SPEND_EX_UNITS)
			.txInInlineDatumPresent()
			.txOut(walletUtxo.output.address, walletUtxo.output.amount)
			.txOutInlineDatumValue(walletUtxo.output.plutusData, 'CBOR')
			.txInCollateral(
				collateral.input.txHash,
				collateral.input.outputIndex,
				collateral.output.amount,
				collateral.output.address,
			)
			.setTotalCollateral('0')
			// Mesh returns the whole collateral to the change address; nothing else is balanced.
			.changeAddress(collateral.output.address)
			.requiredSignerHash(script.owner)
			.setNetwork(network)
			.completeUnbalanced()
	);
}

/**
 * Read the wallet on L1 and build its deposit blueprint. `scriptHash` is what the
 * commit validator must see the committed UTxO locked at; `ownerKeyHash` is the
 * only key that signs the deposit.
 */
export async function prepareOwnerDeposit(params: {
	wallet: GuardedWalletParams;
	rpcApiKey: string;
}): Promise<{ walletUtxo: UTxO; blueprint: string; scriptHash: string; ownerKeyHash: string }> {
	const script = loadSmartWalletScript(params.wallet);
	const walletUtxo = await fetchWalletUtxo(
		new BlockfrostProvider(params.rpcApiKey),
		script,
		params.wallet.stateTokenName,
	);
	const blueprint = buildOwnerDepositBlueprint({ script, walletUtxo, network: params.wallet.network });
	return { walletUtxo, blueprint, scriptHash: script.policyId, ownerKeyHash: script.owner };
}

/** Build the decommit for a wallet found in the head snapshot. See `buildOwnerDecommitTx`. */
/**
 * The decommit, signed by the agent for its collateral, ready for the owner.
 * The agent signs here, on the V2 Mesh line that built the transaction, so no
 * other signer can re-encode it.
 */
export async function prepareOwnerDecommit(params: {
	wallet: GuardedWalletParams;
	walletUtxo: UTxO;
	collateral: UTxO;
	headCostModels: HeadRawCostModels;
	agentMnemonic: string[];
}): Promise<{ unsignedTx: string; txHash: string; ownerKeyHash: string }> {
	const script = loadSmartWalletScript(params.wallet);
	const built = await buildOwnerDecommitTx({
		script,
		walletUtxo: params.walletUtxo,
		collateral: params.collateral,
		headCostModels: params.headCostModels,
		network: params.wallet.network,
	});
	const agent = new MeshWallet({
		networkId: params.wallet.network === 'mainnet' ? 1 : 0,
		key: { type: 'mnemonic', words: params.agentMnemonic },
	});
	await agent.init();
	const agentSigned = await agent.signTx(built.unsignedTx, true);
	// The owner later signs this exact body.
	if (resolveTxHash(agentSigned) !== built.txHash) {
		throw new Error('Signing the withdraw for the collateral changed the transaction body');
	}
	return { unsignedTx: agentSigned, txHash: built.txHash, ownerKeyHash: script.owner };
}

function hasInlineDatum(utxo: UTxO): utxo is UTxO & { output: { plutusData: string } } {
	return typeof utxo.output.plutusData === 'string' && utxo.output.plutusData.length > 0;
}
