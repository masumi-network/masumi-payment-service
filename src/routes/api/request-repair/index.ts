import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { createHash } from 'node:crypto';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import {
	RepairConflictError,
	RepairChainLookupError,
	RepairValidationError,
	repairRequestTransaction,
	validateRepairTransaction,
	type RepairExpectedRequest,
	type RepairExpectedVersion,
	type RepairTargetKind,
} from '@/services/transactions/manual-repair';

export const repairRequestSchemaInput = z.object({
	kind: z.enum(['Purchase', 'Payment']).describe('Whether the blockchainIdentifier refers to a purchase or a payment'),
	network: z.nativeEnum(Network).describe('The network the request belongs to'),
	blockchainIdentifier: z.string().min(1).describe('The request to repair'),
	txHash: z.string().min(64).max(64).describe("The transaction that should become the request's CurrentTransaction"),
	force: z
		.boolean()
		.default(false)
		.optional()
		.describe(
			'Skip chain validation and write the supplied onChainState verbatim. Only for cases validation cannot cover — a mistake here points the request at the wrong escrow and the automatic refund/withdraw logic will act on it.',
		),
	onChainState: z
		.nativeEnum(OnChainState)
		.optional()
		.describe('Required when force is true. Ignored otherwise — the state is read from the transaction datum.'),
	requestVersion: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Opaque request version returned by preview. Required unless force is true; rejects an apply when tx-sync changed the request after preview.',
		),
	expectedRequestUpdatedAt: z.iso
		.datetime()
		.optional()
		.describe(
			'Required for force when requestVersion is unavailable. Pass the request updatedAt shown in the operator dialog to reject stale forced writes.',
		),
});

export const repairRequestSchemaOutput = z.object({
	requestId: z.string(),
	txHash: z.string(),
	transactionId: z.string(),
	previousOnChainState: z.nativeEnum(OnChainState).nullable(),
	newOnChainState: z.nativeEnum(OnChainState),
	forced: z.boolean().describe('True when chain validation was skipped'),
});

const commonRepairRequestSelect = {
	id: true,
	updatedAt: true,
	blockchainIdentifier: true,
	inputHash: true,
	payByTime: true,
	submitResultTime: true,
	unlockTime: true,
	externalDisputeUnlockTime: true,
	collateralReturnLovelace: true,
	buyerReturnAddress: true,
	sellerReturnAddress: true,
	onChainState: true,
	resultHash: true,
	currentTransactionId: true,
	CurrentTransaction: { select: { txHash: true } },
	TransactionHistory: { select: { txHash: true } },
	SmartContractWallet: { select: { walletVkey: true, walletAddress: true } },
	PaymentSource: {
		select: {
			network: true,
			paymentSourceType: true,
			smartContractAddress: true,
			PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
		},
	},
} as const;

type RepairRequestContext = {
	id: string;
	blockchainIdentifier: string;
	onChainState: OnChainState | null;
	paymentSource: {
		network: Network;
		paymentSourceType: PaymentSourceType;
		smartContractAddress: string;
		rpcProviderApiKey: string;
	};
	expectedRequest: RepairExpectedRequest;
	expectedVersion: RepairExpectedVersion;
};

async function findRepairRequest(params: {
	kind: RepairTargetKind;
	network: Network;
	blockchainIdentifier: string;
}): Promise<RepairRequestContext | null> {
	const where = {
		blockchainIdentifier: params.blockchainIdentifier,
		PaymentSource: { network: params.network, deletedAt: null },
	};

	if (params.kind === 'purchase') {
		const request = await prisma.purchaseRequest.findFirst({
			where,
			select: {
				...commonRepairRequestSelect,
				SellerWallet: { select: { walletVkey: true, walletAddress: true } },
				PaidFunds: { select: { unit: true, amount: true } },
			},
		});
		if (request == null) return null;

		return {
			id: request.id,
			blockchainIdentifier: request.blockchainIdentifier,
			onChainState: request.onChainState,
			paymentSource: {
				network: request.PaymentSource.network,
				paymentSourceType: request.PaymentSource.paymentSourceType,
				smartContractAddress: request.PaymentSource.smartContractAddress,
				rpcProviderApiKey: request.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
			},
			expectedRequest: {
				kind: params.kind,
				inputHash: request.inputHash,
				payByTime: request.payByTime,
				submitResultTime: request.submitResultTime,
				unlockTime: request.unlockTime,
				externalDisputeUnlockTime: request.externalDisputeUnlockTime,
				collateralReturnLovelace: request.collateralReturnLovelace,
				buyerReturnAddress: request.buyerReturnAddress,
				sellerReturnAddress: request.sellerReturnAddress,
				buyerWallet: null,
				sellerWallet: request.SellerWallet,
				smartContractWallet: request.SmartContractWallet,
				amounts: request.PaidFunds,
				knownTransactionHashes: [
					request.CurrentTransaction?.txHash,
					...request.TransactionHistory.map((transaction) => transaction.txHash),
				].filter((txHash): txHash is string => txHash != null),
			},
			expectedVersion: {
				updatedAt: request.updatedAt,
				currentTransactionId: request.currentTransactionId,
				onChainState: request.onChainState,
				resultHash: request.resultHash,
			},
		};
	}

	const request = await prisma.paymentRequest.findFirst({
		where,
		select: {
			...commonRepairRequestSelect,
			BuyerWallet: { select: { walletVkey: true, walletAddress: true } },
			RequestedFunds: { select: { unit: true, amount: true } },
		},
	});
	if (request == null) return null;

	return {
		id: request.id,
		blockchainIdentifier: request.blockchainIdentifier,
		onChainState: request.onChainState,
		paymentSource: {
			network: request.PaymentSource.network,
			paymentSourceType: request.PaymentSource.paymentSourceType,
			smartContractAddress: request.PaymentSource.smartContractAddress,
			rpcProviderApiKey: request.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		},
		expectedRequest: {
			kind: params.kind,
			inputHash: request.inputHash,
			payByTime: request.payByTime,
			submitResultTime: request.submitResultTime,
			unlockTime: request.unlockTime,
			externalDisputeUnlockTime: request.externalDisputeUnlockTime,
			collateralReturnLovelace: request.collateralReturnLovelace,
			buyerReturnAddress: request.buyerReturnAddress,
			sellerReturnAddress: request.sellerReturnAddress,
			buyerWallet: request.BuyerWallet,
			sellerWallet: null,
			smartContractWallet: request.SmartContractWallet,
			amounts: request.RequestedFunds,
			knownTransactionHashes: [
				request.CurrentTransaction?.txHash,
				...request.TransactionHistory.map((transaction) => transaction.txHash),
			].filter((txHash): txHash is string => txHash != null),
		},
		expectedVersion: {
			updatedAt: request.updatedAt,
			currentTransactionId: request.currentTransactionId,
			onChainState: request.onChainState,
			resultHash: request.resultHash,
		},
	};
}

function encodeRepairRequestVersion(version: RepairExpectedVersion): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				version.updatedAt.toISOString(),
				version.currentTransactionId,
				version.onChainState,
				version.resultHash,
			]),
		)
		.digest('base64url');
}

/**
 * Repoints a purchase or payment at a specific transaction.
 *
 * The recovery path for a request whose database state has fallen behind the
 * chain — a sync gap, a detached pointer. By default nothing is taken on trust:
 * the transaction is fetched, confirmed to have an output at this payment
 * source's contract address, its datum decoded, and its blockchainIdentifier
 * matched against the request before anything is written. The resulting state
 * comes from the datum, not from the caller.
 *
 * `force` exists for the cases that cannot satisfy those checks, and is
 * deliberately awkward: it requires an explicit state and is logged as forced.
 */
export const repairRequestPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: repairRequestSchemaInput,
	output: repairRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof repairRequestSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const kind: RepairTargetKind = input.kind === 'Purchase' ? 'purchase' : 'payment';
		const force = input.force ?? false;

		if (force && input.onChainState == null) {
			throw createHttpError(400, 'onChainState is required when force is true');
		}
		if (!force && input.requestVersion == null) {
			throw createHttpError(400, 'requestVersion from a successful preview is required when force is false');
		}
		if (force && input.requestVersion == null && input.expectedRequestUpdatedAt == null) {
			throw createHttpError(
				400,
				'expectedRequestUpdatedAt from the operator dialog is required when force is true and requestVersion is unavailable',
			);
		}

		const request = await findRepairRequest({
			kind,
			network: input.network,
			blockchainIdentifier: input.blockchainIdentifier,
		});

		if (request == null) {
			throw createHttpError(404, `${input.kind} request not found for the given blockchainIdentifier and network`);
		}
		if (input.requestVersion != null && input.requestVersion !== encodeRepairRequestVersion(request.expectedVersion)) {
			throw createHttpError(409, 'Request changed after preview; preview the repair again');
		}
		if (
			input.requestVersion == null &&
			input.expectedRequestUpdatedAt != null &&
			input.expectedRequestUpdatedAt !== request.expectedVersion.updatedAt.toISOString()
		) {
			throw createHttpError(409, 'Request changed after the operator dialog loaded; reload before forcing repair');
		}

		try {
			const validation = force
				? null
				: await validateRepairTransaction({
						txHash: input.txHash,
						blockchainIdentifier: request.blockchainIdentifier,
						smartContractAddress: request.paymentSource.smartContractAddress,
						network: request.paymentSource.network,
						rpcProviderApiKey: request.paymentSource.rpcProviderApiKey,
						paymentSourceType: request.paymentSource.paymentSourceType,
						expectedRequest: request.expectedRequest,
					});

			return await repairRequestTransaction({
				kind,
				requestId: request.id,
				txHash: input.txHash,
				validation,
				forcedOnChainState: force ? (input.onChainState ?? null) : null,
				expectedVersion: request.expectedVersion,
			});
		} catch (error) {
			if (error instanceof RepairConflictError) {
				throw createHttpError(409, error.message);
			}
			if (error instanceof RepairChainLookupError) {
				throw createHttpError(502, 'Chain provider could not complete repair validation; retry later');
			}
			if (error instanceof RepairValidationError) {
				// A validation failure is the caller's problem to fix (wrong hash,
				// wrong request), not a server fault — and the detail is the whole
				// point, since it says exactly which check failed.
				throw createHttpError(400, error.detail);
			}
			throw error;
		}
	},
});

export const previewRepairRequestSchemaInput = repairRequestSchemaInput.pick({
	kind: true,
	network: true,
	blockchainIdentifier: true,
	txHash: true,
});

export const previewRepairRequestSchemaOutput = z.object({
	txHash: z.string(),
	outputIndex: z.number(),
	derivedOnChainState: z.nativeEnum(OnChainState),
	resultHash: z.string().nullable(),
	currentOnChainState: z.nativeEnum(OnChainState).nullable(),
	requestVersion: z.string().describe('Opaque version to pass to the apply endpoint as requestVersion'),
});

/**
 * Dry run: validates without writing, so the UI can show what a repair would do
 * before an operator commits to it.
 */
export const previewRepairRequestPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: previewRepairRequestSchemaInput,
	output: previewRepairRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof previewRepairRequestSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const kind: RepairTargetKind = input.kind === 'Purchase' ? 'purchase' : 'payment';
		const request = await findRepairRequest({
			kind,
			network: input.network,
			blockchainIdentifier: input.blockchainIdentifier,
		});

		if (request == null) {
			throw createHttpError(404, `${input.kind} request not found for the given blockchainIdentifier and network`);
		}

		try {
			const validation = await validateRepairTransaction({
				txHash: input.txHash,
				blockchainIdentifier: request.blockchainIdentifier,
				smartContractAddress: request.paymentSource.smartContractAddress,
				network: request.paymentSource.network,
				rpcProviderApiKey: request.paymentSource.rpcProviderApiKey,
				paymentSourceType: request.paymentSource.paymentSourceType,
				expectedRequest: request.expectedRequest,
			});

			return {
				txHash: validation.txHash,
				outputIndex: validation.outputIndex,
				derivedOnChainState: validation.derivedOnChainState,
				resultHash: validation.resultHash,
				currentOnChainState: request.onChainState,
				requestVersion: encodeRepairRequestVersion(request.expectedVersion),
			};
		} catch (error) {
			if (error instanceof RepairChainLookupError) {
				throw createHttpError(502, 'Chain provider could not complete repair validation; retry later');
			}
			if (error instanceof RepairValidationError) {
				throw createHttpError(400, error.detail);
			}
			throw error;
		}
	},
});
