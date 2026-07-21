import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, OnChainState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import {
	RepairValidationError,
	repairRequestTransaction,
	validateRepairTransaction,
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
});

export const repairRequestSchemaOutput = z.object({
	requestId: z.string(),
	txHash: z.string(),
	transactionId: z.string(),
	previousOnChainState: z.nativeEnum(OnChainState).nullable(),
	newOnChainState: z.nativeEnum(OnChainState),
	forced: z.boolean().describe('True when chain validation was skipped'),
});

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

		const where = {
			blockchainIdentifier: input.blockchainIdentifier,
			PaymentSource: { network: input.network, deletedAt: null },
		};
		const select = {
			id: true,
			blockchainIdentifier: true,
			PaymentSource: {
				select: {
					network: true,
					smartContractAddress: true,
					PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
				},
			},
		};

		const request =
			kind === 'purchase'
				? await prisma.purchaseRequest.findFirst({ where, select })
				: await prisma.paymentRequest.findFirst({ where, select });

		if (request == null) {
			throw createHttpError(404, `${input.kind} request not found for the given blockchainIdentifier and network`);
		}

		try {
			const validation = force
				? null
				: await validateRepairTransaction({
						txHash: input.txHash,
						blockchainIdentifier: request.blockchainIdentifier,
						smartContractAddress: request.PaymentSource.smartContractAddress,
						network: request.PaymentSource.network,
						rpcProviderApiKey: request.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
					});

			return await repairRequestTransaction({
				kind,
				requestId: request.id,
				txHash: input.txHash,
				validation,
				forcedOnChainState: force ? (input.onChainState ?? null) : null,
			});
		} catch (error) {
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
		const where = {
			blockchainIdentifier: input.blockchainIdentifier,
			PaymentSource: { network: input.network, deletedAt: null },
		};
		const select = {
			id: true,
			blockchainIdentifier: true,
			onChainState: true,
			PaymentSource: {
				select: {
					network: true,
					smartContractAddress: true,
					PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
				},
			},
		};

		const request =
			kind === 'purchase'
				? await prisma.purchaseRequest.findFirst({ where, select })
				: await prisma.paymentRequest.findFirst({ where, select });

		if (request == null) {
			throw createHttpError(404, `${input.kind} request not found for the given blockchainIdentifier and network`);
		}

		try {
			const validation = await validateRepairTransaction({
				txHash: input.txHash,
				blockchainIdentifier: request.blockchainIdentifier,
				smartContractAddress: request.PaymentSource.smartContractAddress,
				network: request.PaymentSource.network,
				rpcProviderApiKey: request.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
			});

			return {
				txHash: validation.txHash,
				outputIndex: validation.outputIndex,
				derivedOnChainState: validation.derivedOnChainState,
				resultHash: validation.resultHash,
				currentOnChainState: request.onChainState,
			};
		} catch (error) {
			if (error instanceof RepairValidationError) {
				throw createHttpError(400, error.detail);
			}
			throw error;
		}
	},
});
