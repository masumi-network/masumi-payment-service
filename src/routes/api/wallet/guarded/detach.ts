import createHttpError from 'http-errors';
import { inspectGuardedWallet } from '@masumi/payment-source-v2/smart-wallet/guarded-wallet';
import { findGuardedWalletInHead } from './hydra/location';
import { assertNoOpenTransfer, guardedWalletParams, withGuardedWalletLock } from './hydra/transfers';
import { hotWalletBusyError, loadPurchasingHotWallet } from './service';

type Scope = Parameters<typeof loadPurchasingHotWallet>[1];

export async function detachGuardedWallet(hotWalletId: string, scope: Scope) {
	const hotWallet = await loadPurchasingHotWallet(hotWalletId, scope);
	const guarded = hotWallet.GuardedWallet;
	if (guarded == null) throw createHttpError(404, 'This hot wallet is not guarded');
	// A batch in flight holds the lock; detaching now would change how it must be signed.
	if (hotWallet.lockedAt != null || hotWallet.pendingTransactionId != null) throw hotWalletBusyError();
	// Only a guarded hot wallet can withdraw the wallet from a head, so it must be
	// on L1 and not moving. Read live: the transfer records can lag the chain.
	await assertNoOpenTransfer(guarded.id);
	if ((await findGuardedWalletInHead(hotWallet.id, guarded)) != null) {
		throw createHttpError(409, 'The wallet is inside a Hydra head; withdraw it to L1 before detaching');
	}
	try {
		await inspectGuardedWallet(
			guardedWalletParams(guarded, hotWallet.PaymentSource.network),
			hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw createHttpError(409, `The wallet is not on L1, so it may still be moving: ${reason}`);
	}
	// A move prepared during the reads above would be lost with the row.
	return await withGuardedWalletLock(guarded.id, async (tx) => {
		await assertNoOpenTransfer(guarded.id, new Date(), tx);
		return await tx.guardedWallet.delete({ where: { hotWalletId: hotWallet.id } });
	});
}
