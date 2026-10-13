import createHttpError from 'http-errors';
import { logger } from '@masumi/payment-core/logger';
import {
	PolicyUpdateRefusedError,
	prepareOwnerPolicyUpdate,
} from '@masumi/payment-source-v2/smart-wallet/policy-update';
import { GuardedWalletNotOnL1Error } from '@masumi/payment-source-v2/smart-wallet/wallet-lifecycle';
import { assertHotWalletIdle, assertNoOpenTransfer, loadGuardedHotWallet } from './hydra/transfers';

type Scope = Parameters<typeof loadGuardedHotWallet>[1];
type AssetAmount = { unit: string; amount: string };

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const toAssets = (amounts: AssetAmount[]) => amounts.map(({ unit, amount }) => ({ unit, quantity: amount }));

/**
 * The owner's transaction that sets new per-asset limits and moves value in from
 * the owner address. The node keeps no record of it: the owner's browser wallet
 * signs and submits it, and the next chain read shows the new limits.
 */
export async function prepareGuardedPolicyUpdate(
	input: { hotWalletId: string; limits: AssetAmount[]; deposit: AssetAmount[] },
	scope: Scope,
) {
	const { hotWallet, guarded, params } = await loadGuardedHotWallet(input.hotWalletId, scope);
	// A Hydra move is signed against the current wallet UTxO; spending it here would void that move.
	await assertNoOpenTransfer(guarded.id);
	// A purchase lock in flight spends the same wallet UTxO.
	await assertHotWalletIdle(hotWallet.id);

	let prepared: Awaited<ReturnType<typeof prepareOwnerPolicyUpdate>>;
	try {
		prepared = await prepareOwnerPolicyUpdate({
			wallet: params,
			rpcApiKey: hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
			limits: toAssets(input.limits),
			deposit: toAssets(input.deposit),
			governedAsset: guarded.governedAsset,
			isRegisteredWithExchain: guarded.exchainWalletId != null,
		});
	} catch (error) {
		if (error instanceof PolicyUpdateRefusedError) throw createHttpError(400, error.message);
		if (error instanceof GuardedWalletNotOnL1Error) {
			throw createHttpError(409, 'The wallet is not on L1; move it out of the Hydra head first');
		}
		throw createHttpError(409, `The policy update could not be built: ${describeError(error)}`);
	}
	if (prepared.script.address !== guarded.scriptAddress || prepared.script.policyId !== guarded.policyId) {
		throw createHttpError(409, 'The derived wallet script differs from the attached guarded wallet');
	}
	logger.info('Prepared a guarded wallet policy update', { hotWalletId: hotWallet.id, txHash: prepared.txHash });
	return { unsignedTx: prepared.unsignedTx, txHash: prepared.txHash, walletUtxoRef: prepared.walletUtxoRef };
}
