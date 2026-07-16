import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { cursorPaginationArgs } from '@/utils/shared/queries';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { decrypt } from '@/utils/security/encryption';
import { isCardanoAddressForNetwork } from '@masumi/payment-core/payment-source';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { recordBusinessEndpointError } from '@masumi/payment-core/metrics';
import {
	getWalletListSchemaInput,
	getWalletListSchemaOutput,
	getWalletSchemaInput,
	getWalletSchemaOutput,
	patchWalletSchemaInput,
	patchWalletSchemaOutput,
	postWalletSchemaInput,
	postWalletSchemaOutput,
} from './schemas';
import { serializeLowBalanceRecord, serializeLowBalanceSummary } from '@/services/wallets';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';

export {
	getWalletListSchemaInput,
	getWalletListSchemaOutput,
	getWalletSchemaInput,
	getWalletSchemaOutput,
	patchWalletSchemaInput,
	patchWalletSchemaOutput,
	postWalletSchemaInput,
	postWalletSchemaOutput,
};

export const queryWalletListEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getWalletListSchemaInput,
	output: getWalletListSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getWalletListSchemaInput>; ctx: AuthContext }) => {
		const wallets = await prisma.hotWallet.findMany({
			orderBy: { createdAt: 'desc' },
			...cursorPaginationArgs(input.cursorId, input.take),
			where: {
				deletedAt: null,
				...(input.walletType != null ? { type: input.walletType } : {}),
				...(input.paymentSourceId != null ? { paymentSourceId: input.paymentSourceId } : {}),
				...(input.walletVkey != null ? { walletVkey: input.walletVkey } : {}),
				...(input.walletAddress != null ? { walletAddress: input.walletAddress } : {}),
				PaymentSource: {
					network: { in: ctx.networkLimit },
					deletedAt: null,
				},
				...buildHotWalletScopeFilter(ctx.walletScopeIds),
			},
			select: {
				id: true,
				paymentSourceId: true,
				walletVkey: true,
				walletAddress: true,
				type: true,
				collectionAddress: true,
				note: true,
				LowBalanceRules: {
					where: { enabled: true },
					select: {
						id: true,
						assetUnit: true,
						thresholdAmount: true,
						enabled: true,
						status: true,
						lastKnownAmount: true,
						lastCheckedAt: true,
						lastAlertedAt: true,
					},
				},
			},
		});

		return {
			Wallets: wallets.map(({ LowBalanceRules, ...wallet }) => ({
				...wallet,
				LowBalanceSummary: serializeLowBalanceSummary(LowBalanceRules),
			})),
		};
	},
});

export const queryWalletEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getWalletSchemaInput,
	output: getWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getWalletSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			// One query parameterised by type. Previously this was a
			// Selling branch and a near-identical Purchasing branch with a
			// trailing `throw 400`, which meant every new HotWalletType was
			// rejected here by default -- Funding wallets 400'd on both Export
			// Wallet and the low-balance rules panel.
			const walletTypeLabel = input.walletType.toLowerCase();
			const result = await prisma.hotWallet.findFirst({
				where: {
					id: input.id,
					type: input.walletType,
					PaymentSource: {
						network: { in: ctx.networkLimit },
					},
					deletedAt: null,
				},
				include: {
					Secret: {
						select: {
							encryptedMnemonic: true,
							createdAt: true,
							updatedAt: true,
						},
					},
					PendingTransaction: {
						select: {
							createdAt: true,
							updatedAt: true,
							txHash: true,
							lastCheckedAt: true,
						},
					},
					LowBalanceRules: {
						orderBy: [{ assetUnit: 'asc' }],
						select: {
							id: true,
							assetUnit: true,
							thresholdAmount: true,
							enabled: true,
							status: true,
							lastKnownAmount: true,
							lastCheckedAt: true,
							lastAlertedAt: true,
						},
					},
				},
			});
			if (result == null) {
				recordBusinessEndpointError('/api/v1/wallet', 'GET', 404, `${input.walletType} wallet not found`, {
					wallet_id: input.id,
					wallet_type: walletTypeLabel,
					operation: 'wallet_lookup',
				});
				throw createHttpError(404, `${input.walletType} wallet not found`);
			}

			// Success is automatically recorded by middleware

			const base = {
				PendingTransaction: result.PendingTransaction
					? {
							createdAt: result.PendingTransaction.createdAt,
							updatedAt: result.PendingTransaction.updatedAt,
							hash: result.PendingTransaction.txHash,
							lastCheckedAt: result.PendingTransaction.lastCheckedAt,
						}
					: null,
				note: result.note,
				walletVkey: result.walletVkey,
				walletAddress: result.walletAddress,
				collectionAddress: result.collectionAddress,
				LowBalanceSummary: serializeLowBalanceSummary(result.LowBalanceRules),
				LowBalanceRules: result.LowBalanceRules.map(serializeLowBalanceRecord),
			};

			if (input.includeSecret == true) {
				return {
					...base,
					Secret: {
						createdAt: result.Secret.createdAt,
						updatedAt: result.Secret.updatedAt,
						mnemonic: decrypt(result.Secret.encryptedMnemonic),
					},
				};
			}
			return base;
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/wallet', 'GET', statusCode, errorInstance, {
				user_id: ctx.id,
				wallet_id: input.id,
				wallet_type: input.walletType.toLowerCase(),
				operation: 'query_wallet',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});

export const postWalletEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postWalletSchemaInput,
	output: postWalletSchemaOutput,
	handler: async ({ input, ctx }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
			const secretKey = MeshWallet.brew(false);
			const secretWords = typeof secretKey == 'string' ? secretKey.split(' ') : secretKey;

			const wallet = generateOfflineWallet(input.network, secretWords);

			const address = (await wallet.getUnusedAddresses())[0];
			const vKey = resolvePaymentKeyHash(address);

			// Success is automatically recorded by middleware

			return {
				walletMnemonic: secretWords.join(' '),
				walletAddress: address,
				walletVkey: vKey,
			};
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/wallet', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				network: input.network,
				operation: 'create_wallet',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});

export const patchWalletEndpointPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: patchWalletSchemaInput,
	output: patchWalletSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof patchWalletSchemaInput> }) => {
		const wallet = await prisma.hotWallet.findFirst({
			where: {
				id: input.id,
				deletedAt: null,
			},
			include: { PaymentSource: { select: { network: true } } },
		});

		if (wallet == null) {
			throw createHttpError(404, `${input.id} wallet not found`);
		}

		// Validate the collection address against the wallet's network. Without
		// this an admin typo / wrong-network address is stored silently and every
		// later automated collection/batching tx for this wallet fails at build
		// time (or funds get directed to an unspendable-for-them address). null
		// clears the override (the column is set to NULL); only a non-empty
		// value is network-validated before being stored.
		if (input.newCollectionAddress != null && input.newCollectionAddress !== '') {
			if (!isCardanoAddressForNetwork(input.newCollectionAddress, wallet.PaymentSource.network)) {
				throw createHttpError(400, 'newCollectionAddress is not a valid Cardano address for this wallet network');
			}
		}

		const result = await prisma.hotWallet.update({
			where: { id: wallet.id },
			data: { collectionAddress: input.newCollectionAddress },
			include: {
				Secret: false,
				PendingTransaction: {
					select: {
						createdAt: true,
						updatedAt: true,
						txHash: true,
						lastCheckedAt: true,
					},
				},
				LowBalanceRules: {
					orderBy: [{ assetUnit: 'asc' }],
					select: {
						id: true,
						assetUnit: true,
						thresholdAmount: true,
						enabled: true,
						status: true,
						lastKnownAmount: true,
						lastCheckedAt: true,
						lastAlertedAt: true,
					},
				},
			},
		});

		return {
			PendingTransaction: result.PendingTransaction
				? {
						createdAt: result.PendingTransaction.createdAt,
						updatedAt: result.PendingTransaction.updatedAt,
						hash: result.PendingTransaction.txHash,
						lastCheckedAt: result.PendingTransaction.lastCheckedAt,
					}
				: null,
			note: result.note,
			walletVkey: result.walletVkey,
			walletAddress: result.walletAddress,
			collectionAddress: result.collectionAddress,
			LowBalanceSummary: serializeLowBalanceSummary(result.LowBalanceRules),
			LowBalanceRules: result.LowBalanceRules.map(serializeLowBalanceRecord),
		};
	},
});
