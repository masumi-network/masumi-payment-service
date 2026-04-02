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

	const network = wallet.PaymentSource.network;
	const rpcProviderApiKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
	const encryptedMnemonic = wallet.Secret.encryptedMnemonic;

	const {
		wallet: meshWallet,
		blockchainProvider,
		utxos,
		address,
	} = await generateWalletExtended(network, rpcProviderApiKey, encryptedMnemonic);

	const unsignedTx = await new Transaction({
		initiator: meshWallet,
		fetcher: blockchainProvider,
	})
		.sendAssets(transfer.toAddress, [{ unit: 'lovelace', quantity: transfer.lovelaceAmount.toString() }])
		.setMetadata(674, { msg: ['Masumi', 'FundTransfer'] })
		.setNetwork(convertNetwork(network))
		.build();

	const signedTx = await meshWallet.signTx(unsignedTx);
	const txHash = await meshWallet.submitTx(signedTx);

	logger.info(`FundTransfer ${transfer.id} submitted`, { txHash });

	await walletLowBalanceMonitorService.evaluateProjectedHotWalletById({
		hotWalletId: wallet.id,
		walletAddress: address,
		walletUtxos: utxos,
		unsignedTx,
		checkSource: 'submission',
	});

	await prisma.walletFundTransfer.update({
		where: { id: transfer.id },
		data: { txHash },
	});
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
		const pendingTransfers = await prisma.walletFundTransfer.findMany({
			where: {
				status: TransactionStatus.Pending,
				txHash: null,
				// Only process transfers where the wallet is still locked for this specific transfer.
				// Prevents processing orphaned transfers and eliminates double-spend risk.
				PendingForWallet: { isNot: null },
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
