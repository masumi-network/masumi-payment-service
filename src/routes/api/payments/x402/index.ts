import { z } from '@/utils/zod-openapi';
import { PaymentAction } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { BlockfrostProvider } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { CONSTANTS } from '@/utils/config';
import { buildX402FundsLockingTransaction } from '@/services/purchases/x402-build/service';
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

export const buildX402TxPost = readAuthenticatedEndpointFactory.build({
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

		const blockchainProvider = new BlockfrostProvider(payment.PaymentSource.PaymentSourceConfig.rpcProviderApiKey);
		const coinsPerUtxoSize = await getCoinsPerUtxoSize(blockchainProvider);

		const result = await buildX402FundsLockingTransaction({
			purchaseRequestData: {
				blockchainIdentifier: payment.blockchainIdentifier,
				inputHash: payment.inputHash,
				payByTime: BigInt(payment.payByTime),
				submitResultTime: BigInt(payment.submitResultTime),
				unlockTime: BigInt(payment.unlockTime),
				externalDisputeUnlockTime: BigInt(payment.externalDisputeUnlockTime),
				sellerAddress: payment.SmartContractWallet.walletAddress,
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
