import { Prisma, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { Transaction } from '@meshsdk/core';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { errorToString } from '@/utils/converter/error-string-convert';
import { walletLowBalanceMonitorService } from '@/services/wallets';
import { convertNetwork } from '@/utils/converter/network-convert';

const mutex = new Mutex();

type PendingFundTransfer = Prisma.WalletFundTransferGetPayload<{
	include: {
		HotWallet: {
			include: {
				Secret: true;
				PaymentSource: {
					include: { PaymentSourceConfig: true };
				};
			};
		};
	};
}>;

async function processSingleFundTransfer(transfer: PendingFundTransfer): Promise<void> {
	const wallet = transfer.HotWallet;

	if (wallet.deletedAt != null) {
		logger.error(`WalletFundTransfer ${transfer.id}: wallet ${wallet.id} is deleted. Skipping.`);
		await prisma.$transaction([
			prisma.walletFundTransfer.update({
				where: { id: transfer.id },
				data: {
					status: TransactionStatus.FailedViaManualReset,
					errorNote: 'Wallet has been deleted',
				},
			}),
			prisma.hotWallet.update({
				where: { id: wallet.id },
				data: { lockedAt: null, pendingFundTransferId: null },
			}),
		]);
		return;
	}

	// Atomically claim the wallet lock before doing any blockchain work.
	// This prevents double-processing if two scheduler runs overlap.
	const claimed = await prisma.$transaction(async (tx) => {
		const freshWallet = await tx.hotWallet.findFirst({
			where: { id: transfer.hotWalletId, lockedAt: null, deletedAt: null },
		});
		if (!freshWallet) return false;
		await tx.hotWallet.update({
			where: { id: freshWallet.id },
			data: { lockedAt: new Date(), pendingFundTransferId: transfer.id },
		});
		return true;
	});

	if (!claimed) {
		logger.info(
			`WalletFundTransfer ${transfer.id}: wallet ${transfer.hotWalletId} was locked by another process, will retry next cycle`,
		);
		return;
	}

	const network = wallet.PaymentSource.network;
	const rpcProviderApiKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
	const encryptedMnemonic = wallet.Secret.encryptedMnemonic;

	const {
		wallet: meshWallet,
		blockchainProvider,
		utxos,
		address,
	} = await generateWalletExtended(network, rpcProviderApiKey, encryptedMnemonic);

	// Build combined asset list: lovelace first, then any additional native assets.
	const assetsToSend: Array<{ unit: string; quantity: string }> = [
		{ unit: 'lovelace', quantity: transfer.lovelaceAmount.toString() },
	];
	if (transfer.assets) {
		const extraAssets = transfer.assets as Array<{ unit: string; quantity: string }>;
		assetsToSend.push(...extraAssets);
	}

	const unsignedTx = await new Transaction({
		initiator: meshWallet,
		fetcher: blockchainProvider,
	})
		.sendAssets(transfer.toAddress, assetsToSend)
		.setMetadata(674, { msg: ['Masumi', 'FundTransfer'] })
		.setNetwork(convertNetwork(network))
		.build();

	const signedTx = await meshWallet.signTx(unsignedTx);
	const txHash = await meshWallet.submitTx(signedTx);

	logger.info(`FundTransfer ${transfer.id} submitted`, { txHash });

	await prisma.walletFundTransfer.update({
		where: { id: transfer.id },
		data: { txHash },
	});

	try {
		await walletLowBalanceMonitorService.evaluateProjectedHotWalletById({
			hotWalletId: wallet.id,
			walletAddress: address,
			walletUtxos: utxos,
			unsignedTx,
			checkSource: 'submission',
		});
	} catch (monitorError) {
		logger.error(
			`FundTransfer ${transfer.id}: low balance check failed (tx already recorded): ${errorToString(monitorError)}`,
		);
	}
}

export async function processFundTransfers() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking processFundTransfers', { error: e });
		return;
	}

	try {
		// Find pending transfers where the wallet is currently unlocked and available.
		// Locking happens atomically inside processSingleFundTransfer.
		const pendingTransfers = await prisma.walletFundTransfer.findMany({
			where: {
				status: TransactionStatus.Pending,
				txHash: null,
				HotWallet: { lockedAt: null, deletedAt: null },
			},
			take: 50,
			include: {
				HotWallet: {
					include: {
						Secret: true,
						PaymentSource: {
							include: { PaymentSourceConfig: true },
						},
					},
				},
			},
		});

		await Promise.allSettled(
			pendingTransfers.map(async (transfer) => {
				try {
					await processSingleFundTransfer(transfer);
				} catch (error) {
					logger.error(`FundTransfer ${transfer.id} failed: ${errorToString(error)}`);
					await prisma.$transaction([
						prisma.walletFundTransfer.update({
							where: { id: transfer.id },
							data: {
								status: TransactionStatus.FailedViaManualReset,
								errorNote: errorToString(error),
							},
						}),
						prisma.hotWallet.update({
							where: { id: transfer.hotWalletId },
							data: { lockedAt: null, pendingFundTransferId: null },
						}),
					]);
				}
			}),
		);
	} catch (error) {
		logger.error(`Error in processFundTransfers: ${errorToString(error)}`);
	} finally {
		release();
	}
}
