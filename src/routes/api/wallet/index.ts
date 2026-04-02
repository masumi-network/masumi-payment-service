import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { decrypt } from '@/utils/security/encryption';
import { HotWalletType } from '@/generated/prisma/client';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { recordBusinessEndpointError } from '@/utils/metrics';
import {
	getWalletSchemaInput,
	getWalletSchemaOutput,
	patchWalletSchemaInput,
	patchWalletSchemaOutput,
	postWalletSchemaInput,
	postWalletSchemaOutput,
	postWalletFundSchemaInput,
	postWalletFundSchemaOutput,
	getWalletFundSchemaInput,
	getWalletFundSchemaOutput,
} from './schemas';
import { serializeLowBalanceRecord, serializeLowBalanceSummary } from '@/services/wallets';

export {
	getWalletSchemaInput,
	getWalletSchemaOutput,
	patchWalletSchemaInput,
	patchWalletSchemaOutput,
	postWalletSchemaInput,
	postWalletSchemaOutput,
	postWalletFundSchemaInput,
	postWalletFundSchemaOutput,
	getWalletFundSchemaInput,
	getWalletFundSchemaOutput,
};

export const queryWalletEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getWalletSchemaInput,
	output: getWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getWalletSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			if (input.walletType == 'Selling') {
				const result = await prisma.hotWallet.findFirst({
					where: {
						id: input.id,
						type: HotWalletType.Selling,
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
					recordBusinessEndpointError('/api/v1/wallet', 'GET', 404, 'Selling wallet not found', {
						wallet_id: input.id,
						wallet_type: 'selling',
						operation: 'wallet_lookup',
					});
					throw createHttpError(404, 'Selling wallet not found');
				}

				// Success is automatically recorded by middleware

				if (input.includeSecret == true) {
					const decodedMnemonic = decrypt(result.Secret.encryptedMnemonic);
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
						Secret: {
							createdAt: result.Secret.createdAt,
							updatedAt: result.Secret.updatedAt,
							mnemonic: decodedMnemonic,
						},
					};
				}
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
					collectionAddress: result.collectionAddress,
					walletVkey: result.walletVkey,
					walletAddress: result.walletAddress,
					LowBalanceSummary: serializeLowBalanceSummary(result.LowBalanceRules),
					LowBalanceRules: result.LowBalanceRules.map(serializeLowBalanceRecord),
				};
			} else if (input.walletType == 'Purchasing') {
				const result = await prisma.hotWallet.findFirst({
					where: {
						id: input.id,
						type: HotWalletType.Purchasing,
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
					throw createHttpError(404, 'Purchasing wallet not found');
				}

				// Success is automatically recorded by middleware

				if (input.includeSecret == true) {
					const decodedMnemonic = decrypt(result.Secret.encryptedMnemonic);
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
						Secret: {
							createdAt: result.Secret.createdAt,
							updatedAt: result.Secret.updatedAt,
							mnemonic: decodedMnemonic,
						},
					};
				}
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
					collectionAddress: result.collectionAddress,
					walletAddress: result.walletAddress,
					LowBalanceSummary: serializeLowBalanceSummary(result.LowBalanceRules),
					LowBalanceRules: result.LowBalanceRules.map(serializeLowBalanceRecord),
				};
			}
			throw createHttpError(400, 'Invalid wallet type');
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

export const postWalletFundEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postWalletFundSchemaInput,
	output: postWalletFundSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof postWalletFundSchemaInput> }) => {
		if (input.lovelaceAmount < 2_000_000n) {
			throw createHttpError(400, 'lovelaceAmount must be at least 2000000 (2 ADA)');
		}

		const transfer = await prisma.$transaction(async (tx) => {
			const wallet = await tx.hotWallet.findFirst({
				where: { walletAddress: input.fromWalletAddress, lockedAt: null, deletedAt: null },
			});

			if (wallet == null) {
				throw createHttpError(409, 'Wallet not found or is currently locked by another operation');
			}

			const newTransfer = await tx.walletFundTransfer.create({
				data: {
					hotWalletId: wallet.id,
					toAddress: input.toAddress,
					lovelaceAmount: input.lovelaceAmount,
				},
			});

			await tx.hotWallet.update({
				where: { id: wallet.id },
				data: { lockedAt: new Date(), pendingFundTransferId: newTransfer.id },
			});

			return newTransfer;
		});

		return {
			id: transfer.id,
			status: transfer.status,
			txHash: transfer.txHash,
			toAddress: transfer.toAddress,
			lovelaceAmount: transfer.lovelaceAmount.toString(),
			createdAt: transfer.createdAt,
			updatedAt: transfer.updatedAt,
			lastCheckedAt: transfer.lastCheckedAt,
			errorNote: transfer.errorNote,
		};
	},
});

export const getWalletFundEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getWalletFundSchemaInput,
	output: getWalletFundSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof getWalletFundSchemaInput> }) => {
		if (input.id != null) {
			const transfer = await prisma.walletFundTransfer.findUnique({
				where: { id: input.id },
			});
			if (transfer == null) {
				throw createHttpError(404, 'Fund transfer not found');
			}
			return {
				transfers: [
					{
						id: transfer.id,
						status: transfer.status,
						txHash: transfer.txHash,
						toAddress: transfer.toAddress,
						lovelaceAmount: transfer.lovelaceAmount.toString(),
						createdAt: transfer.createdAt,
						updatedAt: transfer.updatedAt,
						lastCheckedAt: transfer.lastCheckedAt,
						errorNote: transfer.errorNote,
					},
				],
			};
		}

		let resolvedHotWalletId = input.hotWalletId;
		if (resolvedHotWalletId == null && input.walletAddress != null) {
			const wallet = await prisma.hotWallet.findFirst({
				where: { walletAddress: input.walletAddress, deletedAt: null },
				select: { id: true },
			});
			if (wallet == null) {
				throw createHttpError(404, 'Wallet not found');
			}
			resolvedHotWalletId = wallet.id;
		}

		const transfers = await prisma.walletFundTransfer.findMany({
			where: {
				hotWalletId: resolvedHotWalletId,
				...(input.cursorId != null ? { id: { lt: input.cursorId } } : {}),
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
		});

		return {
			transfers: transfers.map((t) => ({
				id: t.id,
				status: t.status,
				txHash: t.txHash,
				toAddress: t.toAddress,
				lovelaceAmount: t.lovelaceAmount.toString(),
				createdAt: t.createdAt,
				updatedAt: t.updatedAt,
				lastCheckedAt: t.lastCheckedAt,
				errorNote: t.errorNote,
			})),
		};
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
		});

		if (wallet == null) {
			throw createHttpError(404, `${input.id} wallet not found`);
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
