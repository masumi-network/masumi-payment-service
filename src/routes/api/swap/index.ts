import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import createHttpError from 'http-errors';
import { swapTokens, Token } from '@/services/swap';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { Network, TransactionStatus } from '@prisma/client';
import { prisma } from '@/utils/db';
import { decrypt } from '@/utils/security/encryption';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { logger } from '@/utils/logger';
import {
	swapTokensSchemaInput,
	swapTokensSchemaOutput,
	getSwapConfirmSchemaInput,
	getSwapConfirmSchemaOutput,
	getSwapTransactionsSchemaInput,
	getSwapTransactionsSchemaOutput,
} from './schemas';

export {
	swapTokensSchemaInput,
	swapTokensSchemaOutput,
	getSwapConfirmSchemaInput,
	getSwapConfirmSchemaOutput,
	getSwapTransactionsSchemaInput,
	getSwapTransactionsSchemaOutput,
};

export const swapTokensEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: swapTokensSchemaInput,
	output: swapTokensSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof swapTokensSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		let walletId: string | null = null;
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, Network.Mainnet, ctx.permission);

			// Lock the wallet in a transaction to prevent concurrent usage
			const wallet = await prisma.$transaction(
				async (prisma) => {
					const wallet = await prisma.hotWallet.findFirst({
						where: {
							walletVkey: input.walletVkey,
							deletedAt: null,
							PaymentSource: {
								network: { in: ctx.networkLimit },
							},
						},
						include: {
							Secret: true,
							PaymentSource: {
								include: {
									PaymentSourceConfig: true,
								},
							},
						},
					});

					if (wallet == null) {
						throw createHttpError(404, 'Wallet not found');
					}

					if (wallet.lockedAt != null) {
						throw createHttpError(409, 'Wallet is currently locked and cannot be used for swap');
					}

					if (wallet.PaymentSource.network !== Network.Mainnet) {
						throw createHttpError(400, 'Swap functionality is only available for mainnet wallets');
					}

					if (!wallet.PaymentSource.PaymentSourceConfig) {
						throw createHttpError(400, 'Payment source configuration not found');
					}

					// Lock the wallet atomically
					await prisma.hotWallet.update({
						where: { id: wallet.id, deletedAt: null },
						data: { lockedAt: new Date() },
					});

					return wallet;
				},
				{ isolationLevel: 'Serializable', timeout: 10000 },
			);

			walletId = wallet.id;

			const blockfrostApiKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;

			if (!blockfrostApiKey) {
				throw createHttpError(400, 'Blockfrost API key not found in payment source configuration');
			}

			const mnemonic = decrypt(wallet.Secret.encryptedMnemonic);

			const result = await swapTokens(
				{
					mnemonic: mnemonic,
					fromAmount: input.amount,
					fromToken: input.fromToken as Token,
					toToken: input.toToken as Token,
					poolId: input.poolId,
					slippage: input.slippage,
				},
				blockfrostApiKey,
			);

			await prisma.hotWallet.update({
				where: { id: wallet.id, deletedAt: null },
				data: {
					PendingSwapTransaction: {
						create: {
							txHash: result.txHash,
							status: TransactionStatus.Pending,
							lastCheckedAt: new Date(),
							fromPolicyId: input.fromToken.policyId,
							fromAssetName: input.fromToken.assetName,
							fromAmount: String(input.amount),
							toPolicyId: input.toToken.policyId,
							toAssetName: input.toToken.assetName,
							poolId: input.poolId,
							slippage: input.slippage ?? null,
						},
					},
				},
			});

			return result;
		} catch (error) {
			// Unlock wallet on failure so it can be reused
			if (walletId != null) {
				try {
					await prisma.hotWallet.update({
						where: { id: walletId, deletedAt: null },
						data: { lockedAt: null },
					});
				} catch (unlockError) {
					// Log but don't throw - we don't want to mask the original error
					recordBusinessEndpointError(
						'/api/v1/swap',
						'POST',
						500,
						unlockError instanceof Error ? unlockError : new Error(String(unlockError)),
						{
							user_id: ctx.id,
							operation: 'unlock_wallet_after_swap',
							duration: Date.now() - startTime,
						},
					);
				}
			}

			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/swap', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				operation: 'swap_tokens',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});

export const getSwapConfirmEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getSwapConfirmSchemaInput,
	output: getSwapConfirmSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getSwapConfirmSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, Network.Mainnet, ctx.permission);

			const wallet = await prisma.hotWallet.findFirst({
				where: {
					walletVkey: input.walletVkey,
					deletedAt: null,
					PaymentSource: {
						network: { in: ctx.networkLimit },
					},
				},
				include: {
					PaymentSource: {
						include: {
							PaymentSourceConfig: true,
						},
					},
				},
			});

			if (wallet == null) {
				throw createHttpError(404, 'Wallet not found');
			}

			if (wallet.PaymentSource.network !== Network.Mainnet) {
				throw createHttpError(400, 'Swap confirmation is only available for mainnet wallets');
			}

			const blockfrostApiKey = wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!blockfrostApiKey) {
				throw createHttpError(400, 'Blockfrost API key not found in payment source configuration');
			}

			const blockfrost = getBlockfrostInstance(Network.Mainnet, blockfrostApiKey);

			try {
				const tx = await blockfrost.txs(input.txHash);
				if (!tx.block) {
					return { status: 'pending' as const };
				}
				const block = await blockfrost.blocks(tx.block);

				// Unlock wallet now that the swap tx is confirmed on-chain
				if (wallet.lockedAt != null || wallet.pendingSwapTransactionId != null) {
					if (wallet.pendingSwapTransactionId) {
						try {
							await prisma.swapTransaction.update({
								where: { id: wallet.pendingSwapTransactionId },
								data: {
									status: TransactionStatus.Confirmed,
									confirmations: block.confirmations ?? null,
									lastCheckedAt: new Date(),
								},
							});
						} catch (swapTxError) {
							logger.error('Failed to update swap transaction status', {
								swapTransactionId: wallet.pendingSwapTransactionId,
								txHash: input.txHash,
								error: swapTxError instanceof Error ? swapTxError.message : String(swapTxError),
							});
						}
					}
					try {
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: {
								lockedAt: null,
								pendingSwapTransactionId: null,
							},
						});
					} catch (unlockError) {
						logger.error('Failed to unlock wallet after swap confirmation', {
							walletId: wallet.id,
							txHash: input.txHash,
							error: unlockError instanceof Error ? unlockError.message : String(unlockError),
						});
					}
				}

				return {
					status: 'confirmed' as const,
					confirmations: block.confirmations ?? null,
				};
			} catch (txError: unknown) {
				const msg = txError instanceof Error ? txError.message : String(txError);
				if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
					return { status: 'not_found' as const };
				}
				recordBusinessEndpointError(
					'/api/v1/swap/confirm',
					'GET',
					500,
					txError instanceof Error ? txError : new Error(String(txError)),
					{
						user_id: ctx.id,
						operation: 'swap_confirm_lookup',
						duration: Date.now() - startTime,
					},
				);
				throw txError;
			}
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/swap/confirm', 'GET', statusCode, errorInstance, {
				user_id: ctx.id,
				operation: 'swap_confirm',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});

export const getSwapTransactionsEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getSwapTransactionsSchemaInput,
	output: getSwapTransactionsSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getSwapTransactionsSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, Network.Mainnet, ctx.permission);

		const wallet = await prisma.hotWallet.findFirst({
			where: {
				walletVkey: input.walletVkey,
				deletedAt: null,
				PaymentSource: {
					network: { in: ctx.networkLimit },
				},
			},
		});

		if (wallet == null) {
			throw createHttpError(404, 'Wallet not found');
		}

		const swapTransactions = await prisma.swapTransaction.findMany({
			where: {
				BlocksWallet: { id: wallet.id },
			},
			orderBy: { createdAt: 'desc' },
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			take: input.limit,
		});

		return {
			swapTransactions: swapTransactions.map((tx) => ({
				id: tx.id,
				createdAt: tx.createdAt.toISOString(),
				txHash: tx.txHash,
				status: tx.status,
				confirmations: tx.confirmations,
				fromPolicyId: tx.fromPolicyId,
				fromAssetName: tx.fromAssetName,
				fromAmount: tx.fromAmount,
				toPolicyId: tx.toPolicyId,
				toAssetName: tx.toAssetName,
				poolId: tx.poolId,
				slippage: tx.slippage,
			})),
		};
	},
});
