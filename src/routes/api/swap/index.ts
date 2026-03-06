import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import createHttpError from 'http-errors';
import { swapTokens, getPoolEstimate, Token, cancelSwapOrder, findOrderOutputIndex } from '@/services/swap';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { Network, TransactionStatus, SwapStatus } from '@/generated/prisma/client';
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
	getSwapEstimateSchemaInput,
	getSwapEstimateSchemaOutput,
	cancelSwapSchemaInput,
	cancelSwapSchemaOutput,
	acknowledgeSwapTimeoutSchemaInput,
	acknowledgeSwapTimeoutSchemaOutput,
} from './schemas';

export {
	swapTokensSchemaInput,
	swapTokensSchemaOutput,
	getSwapConfirmSchemaInput,
	getSwapConfirmSchemaOutput,
	getSwapTransactionsSchemaInput,
	getSwapTransactionsSchemaOutput,
	getSwapEstimateSchemaInput,
	getSwapEstimateSchemaOutput,
	cancelSwapSchemaInput,
	cancelSwapSchemaOutput,
	acknowledgeSwapTimeoutSchemaInput,
	acknowledgeSwapTimeoutSchemaOutput,
};

/** How long a pending tx can sit before we consider it timed out (15 minutes). */
const SWAP_TX_TIMEOUT_MS = 15 * 60 * 1000;

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
							swapStatus: SwapStatus.OrderPending,
							lastCheckedAt: new Date(),
							fromPolicyId: input.fromToken.policyId,
							fromAssetName: input.fromToken.assetName,
							fromAmount: String(input.amount),
							toPolicyId: input.toToken.policyId,
							toAssetName: input.toToken.assetName,
							poolId: input.poolId,
							slippage: input.slippage ?? null,
							hotWalletId: wallet.id,
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
					PendingSwapTransaction: true,
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

			// Determine which tx hash to check and what lifecycle transition to make
			const swapTx = wallet.PendingSwapTransaction;
			const currentSwapStatus = swapTx?.swapStatus;

			// If we have a pending cancel, check the cancel tx hash instead
			const txHashToCheck =
				currentSwapStatus === SwapStatus.CancelPending && swapTx?.cancelTxHash ? swapTx.cancelTxHash : input.txHash;

			try {
				const tx = await blockfrost.txs(txHashToCheck);
				if (!tx.block) {
					return {
						status: 'pending' as const,
						swapStatus: currentSwapStatus ?? undefined,
					};
				}
				const block = await blockfrost.blocks(tx.block);

				if (currentSwapStatus === SwapStatus.CancelPending && swapTx) {
					// Cancel tx confirmed → transition to CancelConfirmed
					try {
						await prisma.swapTransaction.update({
							where: { id: swapTx.id },
							data: {
								swapStatus: SwapStatus.CancelConfirmed,
								status: TransactionStatus.Confirmed,
								confirmations: block.confirmations ?? null,
								lastCheckedAt: new Date(),
							},
						});
					} catch (updateError) {
						logger.error('Failed to update swap transaction to CancelConfirmed', {
							swapTransactionId: swapTx.id,
							error: updateError instanceof Error ? updateError.message : String(updateError),
						});
					}

					// Unlock wallet
					try {
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: {
								lockedAt: null,
								pendingSwapTransactionId: null,
							},
						});
					} catch (unlockError) {
						logger.error('Failed to unlock wallet after cancel confirmation', {
							walletId: wallet.id,
							error: unlockError instanceof Error ? unlockError.message : String(unlockError),
						});
					}

					return {
						status: 'confirmed' as const,
						swapStatus: SwapStatus.CancelConfirmed,
						swapTransactionId: swapTx.id,
						confirmations: block.confirmations ?? null,
					};
				}

				if (currentSwapStatus === SwapStatus.OrderPending && swapTx) {
					// Order tx confirmed → transition to OrderConfirmed, find output index, unlock wallet
					let orderOutputIndex: number | null = null;
					try {
						orderOutputIndex = await findOrderOutputIndex(txHashToCheck, blockfrost, wallet.walletAddress);
					} catch (outputError) {
						logger.error('Failed to find order output index', {
							txHash: txHashToCheck,
							error: outputError instanceof Error ? outputError.message : String(outputError),
						});
					}

					try {
						await prisma.swapTransaction.update({
							where: { id: swapTx.id },
							data: {
								swapStatus: SwapStatus.OrderConfirmed,
								status: TransactionStatus.Confirmed,
								confirmations: block.confirmations ?? null,
								lastCheckedAt: new Date(),
								orderOutputIndex,
							},
						});
					} catch (updateError) {
						logger.error('Failed to update swap transaction to OrderConfirmed', {
							swapTransactionId: swapTx.id,
							error: updateError instanceof Error ? updateError.message : String(updateError),
						});
					}

					// Unlock wallet — order is sitting at script address now
					try {
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: {
								lockedAt: null,
								pendingSwapTransactionId: null,
							},
						});
					} catch (unlockError) {
						logger.error('Failed to unlock wallet after order confirmation', {
							walletId: wallet.id,
							error: unlockError instanceof Error ? unlockError.message : String(unlockError),
						});
					}

					return {
						status: 'confirmed' as const,
						swapStatus: SwapStatus.OrderConfirmed,
						swapTransactionId: swapTx.id,
						confirmations: block.confirmations ?? null,
					};
				}

				// Default: legacy behavior for swaps without swapStatus tracking
				if (wallet.lockedAt != null || wallet.pendingSwapTransactionId != null) {
					if (wallet.pendingSwapTransactionId) {
						try {
							await prisma.swapTransaction.update({
								where: { id: wallet.pendingSwapTransactionId },
								data: {
									status: TransactionStatus.Confirmed,
									swapStatus: SwapStatus.Completed,
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
					swapStatus: currentSwapStatus ?? undefined,
					confirmations: block.confirmations ?? null,
				};
			} catch (txError: unknown) {
				const msg = txError instanceof Error ? txError.message : String(txError);
				if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
					// Check for timeout: if tx not found and swap has been pending too long
					if (swapTx && swapTx.createdAt) {
						const elapsed = Date.now() - swapTx.createdAt.getTime();
						const isPendingState =
							currentSwapStatus === SwapStatus.OrderPending || currentSwapStatus === SwapStatus.CancelPending;

						if (isPendingState && elapsed > SWAP_TX_TIMEOUT_MS) {
							const timeoutStatus =
								currentSwapStatus === SwapStatus.OrderPending
									? SwapStatus.OrderSubmitTimeout
									: SwapStatus.CancelSubmitTimeout;

							try {
								await prisma.swapTransaction.update({
									where: { id: swapTx.id },
									data: {
										swapStatus: timeoutStatus,
										status: TransactionStatus.FailedViaTimeout,
										lastCheckedAt: new Date(),
									},
								});
							} catch (updateError) {
								logger.error('Failed to update swap transaction to timeout state', {
									swapTransactionId: swapTx.id,
									error: updateError instanceof Error ? updateError.message : String(updateError),
								});
							}

							// Unlock wallet so it's not stuck
							try {
								await prisma.hotWallet.update({
									where: { id: wallet.id, deletedAt: null },
									data: {
										lockedAt: null,
										pendingSwapTransactionId: null,
									},
								});
							} catch (unlockError) {
								logger.error('Failed to unlock wallet after swap timeout', {
									walletId: wallet.id,
									error: unlockError instanceof Error ? unlockError.message : String(unlockError),
								});
							}

							return {
								status: 'not_found' as const,
								swapStatus: timeoutStatus,
								swapTransactionId: swapTx.id,
							};
						}
					}

					return {
						status: 'not_found' as const,
						swapStatus: currentSwapStatus ?? undefined,
					};
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

export const cancelSwapEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: cancelSwapSchemaInput,
	output: cancelSwapSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof cancelSwapSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		let walletId: string | null = null;
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, Network.Mainnet, ctx.permission);

			// Find the swap transaction
			const swapTx = await prisma.swapTransaction.findUnique({
				where: { id: input.swapTransactionId },
			});

			if (swapTx == null) {
				throw createHttpError(404, 'Swap transaction not found');
			}

			if (swapTx.swapStatus !== SwapStatus.OrderConfirmed) {
				throw createHttpError(
					400,
					`Swap can only be cancelled in OrderConfirmed state (current: ${swapTx.swapStatus})`,
				);
			}

			if (swapTx.orderOutputIndex == null) {
				throw createHttpError(400, 'Order output index not available — cannot cancel');
			}

			if (!swapTx.txHash) {
				throw createHttpError(400, 'Original transaction hash not available');
			}

			// Lock the wallet atomically
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
						throw createHttpError(409, 'Wallet is currently locked');
					}

					if (wallet.PaymentSource.network !== Network.Mainnet) {
						throw createHttpError(400, 'Cancel is only available for mainnet wallets');
					}

					if (!wallet.PaymentSource.PaymentSourceConfig) {
						throw createHttpError(400, 'Payment source configuration not found');
					}

					// Lock wallet and link pending swap transaction
					await prisma.hotWallet.update({
						where: { id: wallet.id, deletedAt: null },
						data: {
							lockedAt: new Date(),
							pendingSwapTransactionId: swapTx.id,
						},
					});

					return wallet;
				},
				{ isolationLevel: 'Serializable', timeout: 10000 },
			);

			walletId = wallet.id;

			const blockfrostApiKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
			if (!blockfrostApiKey) {
				throw createHttpError(400, 'Blockfrost API key not found');
			}

			const mnemonic = decrypt(wallet.Secret.encryptedMnemonic);

			const result = await cancelSwapOrder(
				{
					mnemonic,
					orderTxHash: swapTx.txHash,
					orderOutputIndex: swapTx.orderOutputIndex,
				},
				blockfrostApiKey,
			);

			// Update swap transaction with cancel info
			await prisma.swapTransaction.update({
				where: { id: swapTx.id },
				data: {
					cancelTxHash: result.txHash,
					swapStatus: SwapStatus.CancelPending,
					lastCheckedAt: new Date(),
				},
			});

			return { cancelTxHash: result.txHash };
		} catch (error) {
			// Unlock wallet on failure
			if (walletId != null) {
				try {
					await prisma.hotWallet.update({
						where: { id: walletId, deletedAt: null },
						data: {
							lockedAt: null,
							pendingSwapTransactionId: null,
						},
					});
				} catch (unlockError) {
					recordBusinessEndpointError(
						'/api/v1/swap/cancel',
						'POST',
						500,
						unlockError instanceof Error ? unlockError : new Error(String(unlockError)),
						{
							user_id: ctx.id,
							operation: 'unlock_wallet_after_cancel',
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
			recordBusinessEndpointError('/api/v1/swap/cancel', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				operation: 'cancel_swap',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});

export const acknowledgeSwapTimeoutEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: acknowledgeSwapTimeoutSchemaInput,
	output: acknowledgeSwapTimeoutSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof acknowledgeSwapTimeoutSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, Network.Mainnet, ctx.permission);

			const swapTx = await prisma.swapTransaction.findUnique({
				where: { id: input.swapTransactionId },
			});

			if (swapTx == null) {
				throw createHttpError(404, 'Swap transaction not found');
			}

			if (swapTx.swapStatus !== SwapStatus.OrderSubmitTimeout && swapTx.swapStatus !== SwapStatus.CancelSubmitTimeout) {
				throw createHttpError(400, `Only timed-out swaps can be acknowledged (current: ${swapTx.swapStatus})`);
			}

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

			const blockfrostApiKey = wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!blockfrostApiKey) {
				throw createHttpError(400, 'Blockfrost API key not found');
			}

			const blockfrost = getBlockfrostInstance(Network.Mainnet, blockfrostApiKey);

			if (swapTx.swapStatus === SwapStatus.OrderSubmitTimeout) {
				// Check if the order tx actually made it on-chain after all
				if (swapTx.txHash) {
					try {
						const tx = await blockfrost.txs(swapTx.txHash);
						if (tx.block) {
							// Tx did confirm — recover to OrderConfirmed
							let orderOutputIndex: number | null = null;
							try {
								orderOutputIndex = await findOrderOutputIndex(swapTx.txHash, blockfrost, wallet.walletAddress);
							} catch (outputError) {
								logger.error('Failed to find order output index during acknowledge', {
									txHash: swapTx.txHash,
									error: outputError instanceof Error ? outputError.message : String(outputError),
								});
							}

							await prisma.swapTransaction.update({
								where: { id: swapTx.id },
								data: {
									swapStatus: SwapStatus.OrderConfirmed,
									status: TransactionStatus.Confirmed,
									orderOutputIndex,
									lastCheckedAt: new Date(),
								},
							});

							return {
								swapStatus: SwapStatus.OrderConfirmed,
								message: 'Order tx was confirmed on-chain. Swap is now cancellable.',
							};
						}
					} catch {
						// tx not found on-chain — stays timed out
					}
				}

				// Tx truly never confirmed — mark as failed, nothing to recover
				await prisma.swapTransaction.update({
					where: { id: swapTx.id },
					data: {
						swapStatus: SwapStatus.OrderSubmitTimeout,
						lastCheckedAt: new Date(),
					},
				});

				return {
					swapStatus: SwapStatus.OrderSubmitTimeout,
					message: 'Order tx was never confirmed. Funds remain in wallet.',
				};
			}

			// CancelSubmitTimeout — check if the order UTXO still sits at the script address
			if (swapTx.txHash && swapTx.orderOutputIndex != null) {
				try {
					const utxoResult = await blockfrost.txsUtxos(swapTx.txHash);
					const orderOutput = utxoResult.outputs.find((o) => o.output_index === swapTx.orderOutputIndex);

					if (orderOutput) {
						// Check if the UTXO is still unspent by querying the address UTXOs
						const addressUtxos = await blockfrost.addressesUtxos(orderOutput.address);
						const stillExists = addressUtxos.some(
							(u) => u.tx_hash === swapTx.txHash && u.output_index === swapTx.orderOutputIndex,
						);

						if (stillExists) {
							// UTXO still at script address → cancel didn't go through, reset to OrderConfirmed
							await prisma.swapTransaction.update({
								where: { id: swapTx.id },
								data: {
									swapStatus: SwapStatus.OrderConfirmed,
									cancelTxHash: null,
									lastCheckedAt: new Date(),
								},
							});

							return {
								swapStatus: SwapStatus.OrderConfirmed,
								message: 'Cancel tx failed but order UTXO still exists. You can retry cancelling.',
							};
						}
					}
				} catch (utxoError) {
					logger.error('Failed to check order UTXO during cancel timeout acknowledge', {
						txHash: swapTx.txHash,
						error: utxoError instanceof Error ? utxoError.message : String(utxoError),
					});
				}
			}

			// Also check if cancel tx actually confirmed
			if (swapTx.cancelTxHash) {
				try {
					const cancelTx = await blockfrost.txs(swapTx.cancelTxHash);
					if (cancelTx.block) {
						await prisma.swapTransaction.update({
							where: { id: swapTx.id },
							data: {
								swapStatus: SwapStatus.CancelConfirmed,
								status: TransactionStatus.Confirmed,
								lastCheckedAt: new Date(),
							},
						});

						return {
							swapStatus: SwapStatus.CancelConfirmed,
							message: 'Cancel tx was confirmed on-chain after all. Funds returned.',
						};
					}
				} catch {
					// cancel tx not found
				}
			}

			// UTXO gone and cancel not confirmed — likely scooped by the DEX
			await prisma.swapTransaction.update({
				where: { id: swapTx.id },
				data: {
					swapStatus: SwapStatus.Completed,
					lastCheckedAt: new Date(),
				},
			});

			return {
				swapStatus: SwapStatus.Completed,
				message: 'Order UTXO no longer exists. The swap was likely executed by the DEX.',
			};
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/swap/acknowledge-timeout', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				operation: 'acknowledge_swap_timeout',
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
				hotWalletId: wallet.id,
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
				swapStatus: tx.swapStatus,
				confirmations: tx.confirmations,
				fromPolicyId: tx.fromPolicyId,
				fromAssetName: tx.fromAssetName,
				fromAmount: tx.fromAmount,
				toPolicyId: tx.toPolicyId,
				toAssetName: tx.toAssetName,
				poolId: tx.poolId,
				slippage: tx.slippage,
				cancelTxHash: tx.cancelTxHash,
				orderOutputIndex: tx.orderOutputIndex,
			})),
		};
	},
});

export const getSwapEstimateEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getSwapEstimateSchemaInput,
	output: getSwapEstimateSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof getSwapEstimateSchemaInput>; ctx: AuthContext }) => {
		try {
			return await getPoolEstimate({
				fromToken: { policyId: input.fromPolicyId, assetName: input.fromAssetName, name: '' },
				toToken: { policyId: input.toPolicyId, assetName: input.toAssetName, name: '' },
				poolId: input.poolId,
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error('Swap estimate failed', {
				component: 'swap-estimate',
				error: errorMessage,
			});
			throw createHttpError(400, errorMessage);
		}
	},
});
