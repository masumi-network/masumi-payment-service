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
import { assertNever } from '@/utils/assert-never';
import { createAuthenticatedRateLimitMiddleware } from '@/utils/middleware/rate-limit';
import { buildX402TxSchemaInput, buildX402TxSchemaOutput } from './schemas';
import { isCardanoPubKeyAddressForNetwork } from '@/types/payment-source';

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

// Intentional read-tier auth on a POST verb: this endpoint builds an
// unsigned transaction for the caller to sign — it reads payment-source
// metadata, queries Blockfrost, and returns CBOR. No DB writes, no
// state-changing on-chain submit. POST is used because the input is a
// structured payload that doesn't fit comfortably in a query string, not
// because the operation mutates server state. Keeping this on
// `readAuthenticatedEndpointFactory` ensures the action stays available to
// read-only API keys, which matches the build/preview semantics.
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

		// V2 contract trap: `address_to_verification_key(buyer)` returns None
		// for script-credential addresses, and every redeemer branch that
		// touches the buyer principal does `expect Some(...)`. Funds locked
		// with a script-credential buyer address are permanently unspendable
		// — no `Withdraw`, no `WithdrawRefund`, no `WithdrawDisputed`. Reject
		// at the API boundary before broadcasting the lock tx. (The same
		// restriction is enforced in V1 for symmetry; V1's principal-vkey
		// dereference is structurally similar.) Base and enterprise pubkey
		// addresses are both fine — the validator never reads the stake part.
		if (!isCardanoPubKeyAddressForNetwork(input.buyerAddress, input.network)) {
			throw createHttpError(
				400,
				'buyerAddress must be a Cardano base or enterprise address with a verification-key payment credential. Script-credential addresses (smart wallets, multisig wrappers) cannot interact with the escrow contract; locked funds would be permanently unspendable.',
			);
		}

		// Re-validate the STORED sellerReturnAddress before it flows into the
		// V2 funds-locking tx. The create-payment handler (payments/index.ts)
		// only enforces pubkey credentials for rows it creates;
		// `payment.sellerReturnAddress` here is read back from the DB and may
		// predate that check (legacy row), have been written by another path,
		// or — the original bug — have passed the looser create-time schema
		// refine (isCardanoAddressForNetwork, which accepts script addresses)
		// and been returned via the idempotency-replay branch without
		// re-validation. The datum builder only encodes pubkey base/enterprise
		// addresses; a script-credential address would strand payouts at an
		// address the contract cannot resolve. Fail closed (V2 only — V1 has
		// no such datum requirement).
		const isV2Payment = payment.PaymentSource.paymentSourceType === PaymentSourceType.Web3CardanoV2;
		if (
			isV2Payment &&
			payment.sellerReturnAddress != null &&
			!isCardanoPubKeyAddressForNetwork(payment.sellerReturnAddress, input.network)
		) {
			throw createHttpError(
				409,
				'Stored sellerReturnAddress is not a Cardano base or enterprise address with a payment key credential; this payment cannot be locked on the V2 contract. Recreate the payment with a valid address.',
			);
		}

		const blockchainProvider = await createMeshProvider(payment.PaymentSource.PaymentSourceConfig.rpcProviderApiKey);
		const coinsPerUtxoSize = await getCoinsPerUtxoSize(blockchainProvider);

		// Exhaustive switch (assertNever default) so a new PaymentSourceType is a
		// type error, not a silent V1 fallback (ADR-0004 dispatch discipline).
		const sourceType = payment.PaymentSource.paymentSourceType;
		const purchaseRequestDataBase = {
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
		};
		const sharedBuildArgs = {
			buyerAddress: input.buyerAddress,
			blockchainProvider,
			network: input.network,
			scriptAddress: payment.PaymentSource.smartContractAddress,
			coinsPerUtxoSize,
		};
		let result;
		switch (sourceType) {
			case PaymentSourceType.Web3CardanoV2:
				result = await buildX402FundsLockingTransactionV2({
					purchaseRequestData: purchaseRequestDataBase,
					...sharedBuildArgs,
				});
				break;
			case PaymentSourceType.Web3CardanoV1:
				result = await buildX402FundsLockingTransactionV1({
					purchaseRequestData: {
						...purchaseRequestDataBase,
						paymentSourceType: sourceType,
					},
					...sharedBuildArgs,
				});
				break;
			default:
				assertNever(sourceType);
		}

		return {
			unsignedTxCbor: result.unsignedTxCbor,
			collateralReturnLovelace: result.collateralReturnLovelace.toString(),
		};
	},
});
