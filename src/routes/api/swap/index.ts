import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import createHttpError from 'http-errors';
import { swapTokens, Token } from '@/services/swap';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { Network } from '@prisma/client';
import { prisma } from '@/utils/db';
import { decrypt } from '@/utils/security/encryption';
import { swapTokensSchemaInput, swapTokensSchemaOutput } from './schemas';

export { swapTokensSchemaInput, swapTokensSchemaOutput };

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
					const wallet = await prisma.hotWallet.findUnique({
						where: {
							walletVkey: input.walletVkey,
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

					if (wallet.deletedAt != null) {
						throw createHttpError(404, 'Wallet has been deleted');
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

			return result;
		} catch (error) {
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
		} finally {
			// Always unlock the wallet, even if the swap failed
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
		}
	},
});
