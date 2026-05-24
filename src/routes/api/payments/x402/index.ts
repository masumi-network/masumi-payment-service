import { z } from '@masumi/payment-core/zod';
import { PaymentAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { BlockfrostProvider } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { createMeshProvider } from '@/services/shared';
import { CONSTANTS } from '@masumi/payment-core/config';
import { buildX402FundsLockingTransaction as buildX402FundsLockingTransactionV1 } from '@masumi/payment-source-v1/services/purchases/x402-build/service';
import { buildX402FundsLockingTransactionV2 } from '@masumi/payment-source-v2/services/purchases/x402-build/service';
import { PaymentSourceType } from '@/generated/prisma/client';
import { createAuthenticatedRateLimitMiddleware } from '@/utils/middleware/rate-limit';
import { buildX402TxSchemaInput, buildX402TxSchemaOutput } from './schemas';

export { buildX402TxSchemaInput, buildX402TxSchemaOutput };

async function getCoinsPerUtxoSize(blockchainProvider: BlockfrostProvider): Promise<number> {
	let coinsPerUtxoSize: number = CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE;
	try {
		const params = await blockchainProvider.fetchProtocolParameters();
		if (params.coinsPerUtxoSize != null) {
			coinsPerUtxoSize = params.coinsPerUtxoSize;
		}
	} catch (e) {
		logger.warn('Could not fetch protocol parameters, using fallback for min-UTXO calculation', { error: e });
	}
	return coinsPerUtxoSize;
}

const x402BuildEndpointFactory = readAuthenticatedEndpointFactory.addMiddleware(
	createAuthenticatedRateLimitMiddleware({
		maxRequests: 30,
		windowMs: 60_000,
	}),
);

export const buildX402TxPost = x402BuildEndpointFactory.build({
	method: 'post',
	input: buildX402TxSchemaInput,
	output: buildX402TxSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof buildX402TxSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const payment = await prisma.paymentRequest.findFirst({
			where: {
				blockchainIdentifier: input.blockchainIdentifier,
				PaymentSource: { network: input.network, deletedAt: null },
				NextAction: { requestedAction: PaymentAction.WaitingForExternalAction },
				...buildWalletScopeFilter(ctx.walletScopeIds),
			},
			include: {
				SmartContractWallet: { where: { deletedAt: null } },
				RequestedFunds: true,
				PaymentSource: {
					include: { PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
				},
			},
		});

		if (payment == null) {
			throw createHttpError(404, 'Payment not found or not in a buildable state');
		}
		if (payment.SmartContractWallet == null) {
			throw createHttpError(500, 'No smart contract wallet set for payment request');
		}
		if (payment.payByTime == null || BigInt(payment.payByTime) <= BigInt(Date.now())) {
			throw createHttpError(400, 'Payment has expired');
		}

		const blockchainProvider = await createMeshProvider(payment.PaymentSource.PaymentSourceConfig.rpcProviderApiKey);
		const coinsPerUtxoSize = await getCoinsPerUtxoSize(blockchainProvider);

		const isV2 = payment.PaymentSource.paymentSourceType === PaymentSourceType.Web3CardanoV2;
		const result = isV2
			? await buildX402FundsLockingTransactionV2({
					purchaseRequestData: {
						blockchainIdentifier: payment.blockchainIdentifier,
						inputHash: payment.inputHash,
						payByTime: BigInt(payment.payByTime),
						submitResultTime: BigInt(payment.submitResultTime),
						unlockTime: BigInt(payment.unlockTime),
						externalDisputeUnlockTime: BigInt(payment.externalDisputeUnlockTime),
						sellerAddress: payment.SmartContractWallet.walletAddress,
						sellerReturnAddress: payment.sellerReturnAddress,
						buyerReturnAddress: payment.buyerReturnAddress,
						paidFunds: payment.RequestedFunds.map((f) => ({ unit: f.unit, amount: f.amount })),
					},
					buyerAddress: input.buyerAddress,
					blockchainProvider,
					network: input.network,
					scriptAddress: payment.PaymentSource.smartContractAddress,
					coinsPerUtxoSize,
				})
			: await buildX402FundsLockingTransactionV1({
					purchaseRequestData: {
						blockchainIdentifier: payment.blockchainIdentifier,
						inputHash: payment.inputHash,
						payByTime: BigInt(payment.payByTime),
						submitResultTime: BigInt(payment.submitResultTime),
						unlockTime: BigInt(payment.unlockTime),
						externalDisputeUnlockTime: BigInt(payment.externalDisputeUnlockTime),
						sellerAddress: payment.SmartContractWallet.walletAddress,
						sellerReturnAddress: payment.sellerReturnAddress,
						buyerReturnAddress: payment.buyerReturnAddress,
						paymentSourceType: payment.PaymentSource.paymentSourceType,
						paidFunds: payment.RequestedFunds.map((f) => ({ unit: f.unit, amount: f.amount })),
					},
					buyerAddress: input.buyerAddress,
					blockchainProvider,
					network: input.network,
					scriptAddress: payment.PaymentSource.smartContractAddress,
					coinsPerUtxoSize,
				});

		return {
			unsignedTxCbor: result.unsignedTxCbor,
			collateralReturnLovelace: result.collateralReturnLovelace.toString(),
		};
	},
});
