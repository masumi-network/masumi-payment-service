import { getPaymentScriptV1, getRegistryScriptV1 } from '@/utils/generator/contract-generator';
import { prisma } from '@/utils/db';
import { encrypt } from '@/utils/security/encryption';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { HotWalletType, Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { z } from '@/utils/zod-openapi';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { DEFAULTS } from '@/utils/config';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { logger } from '@/utils/logger';
import { walletLowBalanceMonitorService } from '@/services/wallets';
import {
	paymentSourceExtendedCreateSchemaInput,
	paymentSourceExtendedCreateSchemaOutput,
	paymentSourceExtendedDeleteSchemaInput,
	paymentSourceExtendedDeleteSchemaOutput,
	paymentSourceExtendedOutputSchema,
	paymentSourceExtendedSchemaInput,
	paymentSourceExtendedSchemaOutput,
	paymentSourceExtendedUpdateSchemaInput,
	paymentSourceExtendedUpdateSchemaOutput,
} from './schemas';
import { getPaymentSourceExtendedForQuery, paymentSourceExtendedInclude } from './queries';
import { serializePaymentSourceExtendedEntry, serializePaymentSourceExtendedResponse } from './serializers';

export {
	paymentSourceExtendedCreateSchemaInput,
	paymentSourceExtendedCreateSchemaOutput,
	paymentSourceExtendedDeleteSchemaInput,
	paymentSourceExtendedDeleteSchemaOutput,
	paymentSourceExtendedOutputSchema,
	paymentSourceExtendedSchemaInput,
	paymentSourceExtendedSchemaOutput,
	paymentSourceExtendedUpdateSchemaInput,
	paymentSourceExtendedUpdateSchemaOutput,
};

async function resolveLatestIdentifierCheckpoint(
	network: Network,
	rpcProviderApiKey: string,
	smartContractAddress: string,
): Promise<string | null> {
	const blockfrost = getBlockfrostInstance(network, rpcProviderApiKey);

	try {
		const transactions = await blockfrost.addressesTransactions(smartContractAddress, {
			page: 1,
			order: 'desc',
			count: 1,
		});

		if (transactions.length === 0) {
			logger.info('No existing transactions found for new payment source', {
				smartContractAddress,
			});
			return null;
		}

		const latestTxHash = transactions[0].tx_hash;
		logger.info('Setting sync checkpoint to latest transaction', {
			smartContractAddress,
			latestTxHash,
		});
		return latestTxHash;
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.includes('404') || error.message.toLowerCase().includes('not found'))
		) {
			logger.info('Smart contract address has no transaction history yet', {
				smartContractAddress,
			});
			return null;
		}

		logger.error('Failed to fetch transaction history from Blockfrost', {
			smartContractAddress,
			error: error instanceof Error ? error.message : String(error),
		});
		throw createHttpError(
			503,
			'Unable to verify smart contract status. Please check your Blockfrost API key and try again.',
		);
	}
}

export const paymentSourceExtendedEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: paymentSourceExtendedSchemaInput,
	output: paymentSourceExtendedSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof paymentSourceExtendedSchemaInput>; ctx: AuthContext }) => {
		const paymentSources = await getPaymentSourceExtendedForQuery(input, ctx.networkLimit);
		return serializePaymentSourceExtendedResponse(paymentSources);
	},
});

export const paymentSourceExtendedEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: paymentSourceExtendedCreateSchemaInput,
	output: paymentSourceExtendedCreateSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof paymentSourceExtendedCreateSchemaInput>;
		ctx: AuthContext;
	}) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const sellingWalletsMesh = input.SellingWallets.map((sellingWallet) => {
			return {
				wallet: generateOfflineWallet(input.network, sellingWallet.walletMnemonic.split(' ')),
				note: sellingWallet.note,
				mnemonicEncrypted: encrypt(sellingWallet.walletMnemonic),
				collectionAddress: sellingWallet.collectionAddress,
			};
		});
		const purchasingWalletsMesh = input.PurchasingWallets.map((purchasingWallet) => {
			return {
				wallet: generateOfflineWallet(input.network, purchasingWallet.walletMnemonic.split(' ')),
				note: purchasingWallet.note,
				mnemonicEncrypted: encrypt(purchasingWallet.walletMnemonic),
				collectionAddress: purchasingWallet.collectionAddress,
			};
		});

		const createdPaymentSource = await prisma.$transaction(async (prisma) => {
			const { smartContractAddress } = await getPaymentScriptV1(
				input.AdminWallets[0].walletAddress,
				input.AdminWallets[1].walletAddress,
				input.AdminWallets[2].walletAddress,
				input.FeeReceiverNetworkWallet.walletAddress,
				input.feeRatePermille,
				input.cooldownTime ??
					(input.network == Network.Preprod ? DEFAULTS.COOLDOWN_TIME_PREPROD : DEFAULTS.COOLDOWN_TIME_MAINNET),
				input.network,
			);

			const { policyId } = await getRegistryScriptV1(smartContractAddress, input.network);
			const latestIdentifierChecked = await resolveLatestIdentifierCheckpoint(
				input.network,
				input.PaymentSourceConfig.rpcProviderApiKey,
				smartContractAddress,
			);

			const sellingWallets = await Promise.all(
				sellingWalletsMesh.map(async (sw) => {
					return {
						walletAddress: (await sw.wallet.getUnusedAddresses())[0],
						walletVkey: resolvePaymentKeyHash((await sw.wallet.getUnusedAddresses())[0]),
						secretId: (
							await prisma.walletSecret.create({
								data: { encryptedMnemonic: sw.mnemonicEncrypted },
							})
						).id,
						note: sw.note,
						type: HotWalletType.Selling,
						collectionAddress: sw.collectionAddress,
					};
				}),
			);

			const purchasingWallets = await Promise.all(
				purchasingWalletsMesh.map(async (pw) => {
					return {
						walletVkey: resolvePaymentKeyHash((await pw.wallet.getUnusedAddresses())[0]),
						walletAddress: (await pw.wallet.getUnusedAddresses())[0],
						secretId: (
							await prisma.walletSecret.create({
								data: { encryptedMnemonic: pw.mnemonicEncrypted },
							})
						).id,
						note: pw.note,
						type: HotWalletType.Purchasing,
						collectionAddress: pw.collectionAddress,
					};
				}),
			);

			const paymentSource = await prisma.paymentSource.create({
				data: {
					network: input.network,
					smartContractAddress: smartContractAddress,
					policyId: policyId,
					lastIdentifierChecked: latestIdentifierChecked,
					PaymentSourceConfig: {
						create: {
							rpcProviderApiKey: input.PaymentSourceConfig.rpcProviderApiKey,
							rpcProvider: input.PaymentSourceConfig.rpcProvider,
						},
					},
					cooldownTime:
						input.cooldownTime ??
						(input.network == Network.Preprod ? DEFAULTS.COOLDOWN_TIME_PREPROD : DEFAULTS.COOLDOWN_TIME_MAINNET),
					AdminWallets: {
						createMany: {
							data: input.AdminWallets.map((aw, index) => ({
								walletAddress: aw.walletAddress,
								order: index,
							})),
						},
					},
					feeRatePermille: input.feeRatePermille,
					FeeReceiverNetworkWallet: {
						create: {
							walletAddress: input.FeeReceiverNetworkWallet.walletAddress,
							order: 0,
						},
					},
					HotWallets: {
						createMany: {
							data: [...purchasingWallets, ...sellingWallets],
						},
					},
				},
				include: {
					HotWallets: {
						where: { deletedAt: null },
						select: {
							id: true,
						},
					},
				},
			});

			return paymentSource;
		});

		await walletLowBalanceMonitorService.seedDefaultRulesForWallets(
			createdPaymentSource.HotWallets.map((wallet) => wallet.id),
		);

		const paymentSource = await prisma.paymentSource.findUniqueOrThrow({
			where: {
				id: createdPaymentSource.id,
			},
			include: paymentSourceExtendedInclude,
		});

		return serializePaymentSourceExtendedEntry(paymentSource);
	},
});

export const paymentSourceExtendedEndpointPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: paymentSourceExtendedUpdateSchemaInput,
	output: paymentSourceExtendedUpdateSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof paymentSourceExtendedUpdateSchemaInput>;
		ctx: AuthContext;
	}) => {
		const paymentSource = await prisma.paymentSource.findUnique({
			where: {
				id: input.id,
				network: { in: ctx.networkLimit },
				deletedAt: null,
			},
			select: {
				id: true,
				network: true,
				HotWallets: {
					where: {
						deletedAt: null,
					},
					select: {
						id: true,
					},
				},
			},
		});
		if (paymentSource == null) {
			throw createHttpError(404, 'Payment source not found');
		}
		const sellingWalletsMesh = input.AddSellingWallets?.map((sellingWallet) => {
			return {
				wallet: generateOfflineWallet(paymentSource.network, sellingWallet.walletMnemonic.split(' ')),
				note: sellingWallet.note,
				mnemonicEncrypted: encrypt(sellingWallet.walletMnemonic),
				collectionAddress: sellingWallet.collectionAddress,
			};
		});
		const purchasingWalletsMesh = input.AddPurchasingWallets?.map((purchasingWallet) => {
			return {
				wallet: generateOfflineWallet(paymentSource.network, purchasingWallet.walletMnemonic.split(' ')),
				note: purchasingWallet.note,
				mnemonicEncrypted: encrypt(purchasingWallet.walletMnemonic),
				collectionAddress: purchasingWallet.collectionAddress,
			};
		});
		const result = await prisma.$transaction(async (prisma) => {
			const sellingWallets =
				sellingWalletsMesh != null
					? await Promise.all(
							sellingWalletsMesh.map(async (sw) => {
								return {
									walletAddress: (await sw.wallet.getUnusedAddresses())[0],
									walletVkey: resolvePaymentKeyHash((await sw.wallet.getUnusedAddresses())[0]),
									secretId: (
										await prisma.walletSecret.create({
											data: { encryptedMnemonic: sw.mnemonicEncrypted },
										})
									).id,
									note: sw.note,
									type: HotWalletType.Selling,
									collectionAddress: sw.collectionAddress,
								};
							}),
						)
					: [];

			const purchasingWallets =
				purchasingWalletsMesh != null
					? await Promise.all(
							purchasingWalletsMesh.map(async (pw) => {
								return {
									walletAddress: (await pw.wallet.getUnusedAddresses())[0],
									walletVkey: resolvePaymentKeyHash((await pw.wallet.getUnusedAddresses())[0]),
									secretId: (
										await prisma.walletSecret.create({
											data: { encryptedMnemonic: pw.mnemonicEncrypted },
										})
									).id,
									note: pw.note,
									type: HotWalletType.Purchasing,
									collectionAddress: pw.collectionAddress,
								};
							}),
						)
					: [];

			const walletIdsToRemove = [...(input.RemoveSellingWallets ?? []), ...(input.RemovePurchasingWallets ?? [])].map(
				(rw) => rw.id,
			);

			if (walletIdsToRemove.length > 0) {
				await prisma.paymentSource.update({
					where: { id: input.id },
					data: {
						HotWallets: {
							updateMany: {
								where: { id: { in: walletIdsToRemove } },
								data: { deletedAt: new Date() },
							},
						},
					},
				});
			}

			const updatedPaymentSource = await prisma.paymentSource.update({
				where: { id: input.id },
				data: {
					lastIdentifierChecked: input.lastIdentifierChecked,
					PaymentSourceConfig:
						input.PaymentSourceConfig != null
							? {
									update: {
										rpcProviderApiKey: input.PaymentSourceConfig.rpcProviderApiKey,
									},
								}
							: undefined,
					HotWallets: {
						createMany: {
							data: [...purchasingWallets, ...sellingWallets],
						},
					},
				},
				include: {
					HotWallets: {
						where: { deletedAt: null },
						select: {
							id: true,
						},
					},
				},
			});

			return updatedPaymentSource;
		});

		const existingWalletIds = new Set(paymentSource.HotWallets.map((wallet) => wallet.id));
		const createdWalletIds = result.HotWallets.map((wallet) => wallet.id).filter(
			(walletId) => !existingWalletIds.has(walletId),
		);
		await walletLowBalanceMonitorService.seedDefaultRulesForWallets(createdWalletIds);

		const paymentSourceWithRelations = await prisma.paymentSource.findUniqueOrThrow({
			where: {
				id: result.id,
			},
			include: paymentSourceExtendedInclude,
		});

		return serializePaymentSourceExtendedEntry(paymentSourceWithRelations);
	},
});

export const paymentSourceExtendedEndpointDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: paymentSourceExtendedDeleteSchemaInput,
	output: paymentSourceExtendedDeleteSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof paymentSourceExtendedDeleteSchemaInput>;
		ctx: AuthContext;
	}) => {
		const paymentSource = await prisma.paymentSource.update({
			where: { id: input.id, network: { in: ctx.networkLimit } },
			data: { deletedAt: new Date() },
			include: paymentSourceExtendedInclude,
		});
		return serializePaymentSourceExtendedEntry(paymentSource);
	},
});
