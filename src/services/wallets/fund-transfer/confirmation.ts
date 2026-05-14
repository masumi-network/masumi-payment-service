import { TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { createMeshProvider } from '@/services/shared';
import { CONFIG } from '@/utils/config';
import { errorToString } from '@/utils/converter/error-string-convert';

export async function checkFundTransferConfirmations(): Promise<void> {
	// Find wallets that have an active pending fund transfer due for a confirmation check.
	const wallets = await prisma.hotWallet.findMany({
		where: {
			PendingFundTransfer: {
				OR: [
					{ lastCheckedAt: null },
					{
						lastCheckedAt: {
							lte: new Date(Date.now() - CONFIG.CHECK_FUND_TRANSFER_CONFIRMATION_INTERVAL * 1000),
						},
					},
				],
			},
			deletedAt: null,
		},
		include: {
			PendingFundTransfer: true,
			PaymentSource: { include: { PaymentSourceConfig: true } },
		},
	});

	await Promise.allSettled(
		wallets.map(async (wallet) => {
			try {
				if (wallet.PendingFundTransfer == null) {
					logger.error(`Wallet ${wallet.id} has no pending fund transfer when expected. Skipping.`);
					return;
				}

				const fundTransferId = wallet.PendingFundTransfer.id;
				const txHash = wallet.PendingFundTransfer.txHash;
				const isTimedOut =
					wallet.lockedAt != null &&
					new Date(wallet.lockedAt) < new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL);

				let finalStatus: TransactionStatus | null = null;
				let shouldUnlock = false;

				if (txHash == null) {
					// Transfer locked the wallet but hasn't been submitted yet.
					if (isTimedOut) {
						finalStatus = TransactionStatus.FailedViaTimeout;
						shouldUnlock = true;
					}
				} else {
					const blockfrostKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
					const provider = createMeshProvider(blockfrostKey);
					try {
						const txInfo = await provider.fetchTxInfo(txHash);
						if (txInfo) {
							finalStatus = TransactionStatus.Confirmed;
							shouldUnlock = true;
						} else if (isTimedOut) {
							finalStatus = TransactionStatus.FailedViaTimeout;
							shouldUnlock = true;
						}
					} catch {
						// Blockfrost 404 or network error — tx not yet on-chain.
						if (isTimedOut) {
							finalStatus = TransactionStatus.FailedViaTimeout;
							shouldUnlock = true;
						}
					}
				}

				if (shouldUnlock) {
					if (finalStatus == null) {
						logger.error(
							`Wallet ${wallet.id}: shouldUnlock is true but finalStatus is null. Skipping unlock to avoid data corruption.`,
						);
						return;
					}
					await prisma.$transaction([
						prisma.walletFundTransfer.update({
							where: { id: fundTransferId },
							data: {
								status: finalStatus,
								lastCheckedAt: new Date(),
							},
						}),
						prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: { pendingFundTransferId: null, lockedAt: null },
						}),
					]);
				} else {
					await prisma.walletFundTransfer.update({
						where: { id: fundTransferId },
						data: { lastCheckedAt: new Date() },
					});
				}
			} catch (error) {
				logger.error(`Error checking fund transfer confirmation for wallet ${wallet.id}: ${errorToString(error)}`);
			}
		}),
	);
}
