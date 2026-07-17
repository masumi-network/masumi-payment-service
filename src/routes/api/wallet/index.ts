import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { cursorPaginationArgs } from '@/utils/shared/queries';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { decrypt } from '@/utils/security/encryption';
import { HotWalletType, Prisma, WalletFundTransfer } from '@/generated/prisma/client';
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
	postWalletFundSchemaInput,
	postWalletFundSchemaOutput,
	getWalletFundSchemaInput,
	getWalletFundSchemaOutput,
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
	postWalletFundSchemaInput,
	postWalletFundSchemaOutput,
	getWalletFundSchemaInput,
	getWalletFundSchemaOutput,
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

/**
 * Shape a WalletFundTransfer row for the wire.
 *
 * BigInt becomes a string because JSON cannot serialize BigInt. `assets` is a
 * Prisma Json column: postWalletFundEndpointPost is its only writer and zod
 * validated the shape on the way in, so the cast holds today — a second writer
 * (a backfill, an admin script) would need a parse here instead.
 */
function serializeFundTransfer(transfer: WalletFundTransfer) {
	return {
		id: transfer.id,
		status: transfer.status,
		txHash: transfer.txHash,
		toAddress: transfer.toAddress,
		lovelaceAmount: transfer.lovelaceAmount.toString(),
		assets: (transfer.assets as Array<{ unit: string; quantity: string }> | null) ?? null,
		createdAt: transfer.createdAt,
		updatedAt: transfer.updatedAt,
		lastCheckedAt: transfer.lastCheckedAt,
		errorNote: transfer.errorNote,
	};
}

export const postWalletFundEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postWalletFundSchemaInput,
	output: postWalletFundSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postWalletFundSchemaInput>; ctx: AuthContext }) => {
		if (input.lovelaceAmount < 2_000_000n) {
			throw createHttpError(400, 'lovelaceAmount must be at least 2000000 (2 ADA)');
		}

		const wallet = await prisma.hotWallet.findFirst({
			where: {
				walletAddress: input.fromWalletAddress,
				deletedAt: null,
				// Both of these are provable no-ops for an admin key today:
				// auth-middleware grants every canAdmin key all Cardano networks and
				// a null wallet scope, and this factory admits only canAdmin keys. So
				// they are NOT a security control — they are here so the handler stays
				// correct if the endpoint is ever moved to a narrower factory, which
				// is the point at which their absence would become exploitable.
				PaymentSource: { network: { in: ctx.networkLimit }, deletedAt: null },
				...buildHotWalletScopeFilter(ctx.walletScopeIds),
			},
			include: { PaymentSource: { select: { network: true } } },
		});

		if (wallet == null) {
			throw createHttpError(404, 'Wallet not found');
		}

		// Validate the destination against the sending wallet's network, exactly as
		// patchWalletEndpointPatch does for newCollectionAddress below. Without it a
		// wrong-network or truncated address is accepted here, queued, and only
		// rejected by `build()` inside the scheduler seconds later — surfacing to
		// the operator as an async failed transfer instead of a synchronous 400.
		if (!isCardanoAddressForNetwork(input.toAddress, wallet.PaymentSource.network)) {
			throw createHttpError(400, 'toAddress is not a valid Cardano address for this wallet network');
		}

		const transfer = await prisma.walletFundTransfer.create({
			data: {
				hotWalletId: wallet.id,
				toAddress: input.toAddress,
				lovelaceAmount: input.lovelaceAmount,
				// DbNull (SQL NULL), not JsonNull ('null'::jsonb): "no assets" should
				// be absent, not a stored JSON null that `WHERE assets IS NULL` misses.
				assets: input.assets ?? Prisma.DbNull,
			},
		});

		return serializeFundTransfer(transfer);
	},
});

export const getWalletFundEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getWalletFundSchemaInput,
	output: getWalletFundSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getWalletFundSchemaInput>; ctx: AuthContext }) => {
		// Reach every transfer through its HotWallet, so a lookup by transfer id
		// obeys the same visibility rules as a lookup by wallet id or address.
		// The `id` branch previously used findUnique with no wallet filter at all.
		const hotWalletScope = {
			deletedAt: null,
			PaymentSource: { network: { in: ctx.networkLimit }, deletedAt: null },
			...buildHotWalletScopeFilter(ctx.walletScopeIds),
		};

		if (input.id !== undefined) {
			const transfer = await prisma.walletFundTransfer.findFirst({
				where: { id: input.id, HotWallet: hotWalletScope },
			});
			if (transfer == null) {
				throw createHttpError(404, 'Fund transfer not found');
			}
			return { transfers: [serializeFundTransfer(transfer)] };
		}

		let resolvedHotWalletId = input.hotWalletId;
		if (resolvedHotWalletId == null && input.walletAddress != null) {
			const wallet = await prisma.hotWallet.findFirst({
				where: { walletAddress: input.walletAddress, ...hotWalletScope },
				select: { id: true },
			});
			if (wallet == null) {
				throw createHttpError(404, 'Wallet not found');
			}
			resolvedHotWalletId = wallet.id;
		}

		const transfers = await prisma.walletFundTransfer.findMany({
			where: { hotWalletId: resolvedHotWalletId, HotWallet: hotWalletScope },
			orderBy: { createdAt: 'desc' },
			// Inclusive cursor, matching every other list endpoint. The hand-rolled
			// `id: { lt: cursorId }` this replaces was exclusive, so clients would
			// have had to special-case this one route.
			...cursorPaginationArgs(input.cursorId, input.limit),
		});

		return { transfers: transfers.map(serializeFundTransfer) };
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
