import { Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { logger } from '@masumi/payment-core/logger';
import { ez } from 'express-zod-api';
import { z } from '@masumi/payment-core/zod';
import { needsManualActionDataFilter } from '@/utils/shared/queries';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';

const MAX_ACKNOWLEDGE_BATCH = 100;

export const acknowledgeManualActionSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The network the requests were made on'),
	requests: z
		.array(
			z.object({
				blockchainIdentifier: z.string().min(1).max(8000).describe('The blockchain identifier of the request'),
				nextActionLastChangedAt: ez
					.dateIn()
					.describe(
						'nextActionLastChangedAt as the caller last read it. A request whose action or error changed since then is skipped, so an error the caller has not seen stays in Needs Action.',
					),
			}),
		)
		.min(1)
		.max(MAX_ACKNOWLEDGE_BATCH)
		.describe('The requests to acknowledge'),
});

export const acknowledgeManualActionSchemaOutput = z.object({
	acknowledgedCount: z
		.number()
		.describe('Requests that were in Needs Action and are now acknowledged. Others in the list are skipped.'),
});

type AcknowledgeInput = z.infer<typeof acknowledgeManualActionSchemaInput>;

/**
 * Where-fragment for the request that owns the action-data row. Same scope as
 * error-state-recovery: wallet scope always, and only the creating key unless
 * the caller is admin. Rows outside it are skipped, not reported.
 */
function buildOwnedRequestFilter(input: AcknowledgeInput, ctx: AuthContext) {
	return {
		OR: input.requests.map(({ blockchainIdentifier, nextActionLastChangedAt }) => ({
			blockchainIdentifier,
			nextActionLastChangedAt,
		})),
		PaymentSource: { network: input.network, deletedAt: null },
		...buildWalletScopeFilter(ctx.walletScopeIds),
		...(ctx.canAdmin ? {} : { requestedById: ctx.id }),
	};
}

/**
 * Hides requests from Needs Action. Writes only the acknowledgement on the
 * current action-data row: NextAction, Transaction rows and on-chain state stay
 * as they are. A DB trigger clears the acknowledgement when the action or the
 * error changes, so a new error shows up again.
 */
export const paymentAcknowledgeManualActionPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: acknowledgeManualActionSchemaInput,
	output: acknowledgeManualActionSchemaOutput,
	handler: async ({ input, ctx }: { input: AcknowledgeInput; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const { count } = await prisma.paymentActionData.updateMany({
			where: {
				...needsManualActionDataFilter,
				PaymentRequestCurrent: { is: buildOwnedRequestFilter(input, ctx) },
			},
			data: { manualActionAcknowledgedAt: new Date() },
		});
		logger.info('Acknowledged payment requests in Needs Action', {
			requested: input.requests.length,
			acknowledged: count,
		});
		return { acknowledgedCount: count };
	},
});

export const purchaseAcknowledgeManualActionPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: acknowledgeManualActionSchemaInput,
	output: acknowledgeManualActionSchemaOutput,
	handler: async ({ input, ctx }: { input: AcknowledgeInput; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const { count } = await prisma.purchaseActionData.updateMany({
			where: {
				...needsManualActionDataFilter,
				PurchaseRequestCurrent: { is: buildOwnedRequestFilter(input, ctx) },
			},
			data: { manualActionAcknowledgedAt: new Date() },
		});
		logger.info('Acknowledged purchase requests in Needs Action', {
			requested: input.requests.length,
			acknowledged: count,
		});
		return { acknowledgedCount: count };
	},
});
