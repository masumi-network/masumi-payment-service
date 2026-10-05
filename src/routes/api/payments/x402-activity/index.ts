import { Network, X402PaymentDirection, X402PaymentStatus } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { z } from '@masumi/payment-core/zod';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { ez } from 'express-zod-api';
import { listX402AgentPaymentActivity } from '@masumi/payment-source-x402/service';
import { assertRegistryAgentInWalletScope } from '../x402-agent-access';
import {
	createEarningsRateLimitMiddleware,
	withEarningsConcurrency,
	concurrencyResponseMiddleware,
} from '@/utils/earnings-request-control';

const x402ActivityEndpointFactory = readAuthenticatedEndpointFactory
	.addMiddleware(createEarningsRateLimitMiddleware())
	.addMiddleware(concurrencyResponseMiddleware);

export const postX402AgentPaymentActivitySchemaInput = z.object({
	agentIdentifier: z.string().min(57).max(250).describe('Registry agent identifier to list x402 payment activity for'),
	startDate: ez
		.dateIn()
		.optional()
		.nullable()
		.describe('Start of the activity window (inclusive). Defaults to earliest data when omitted.'),
	endDate: ez
		.dateIn()
		.optional()
		.nullable()
		.describe('End of the activity window (inclusive). Defaults to today when omitted.'),
	take: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(50)
		.describe('Maximum number of attempts to return, newest first'),
	network: z.nativeEnum(Network).describe('Cardano network bucket for registry rows on this node'),
});

const x402ActivityAttemptSchema = z.object({
	id: z.string(),
	createdAt: z.date(),
	direction: z.nativeEnum(X402PaymentDirection),
	status: z.nativeEnum(X402PaymentStatus),
	caip2Network: z.string(),
	asset: z.string(),
	amount: z.string(),
	payTo: z.string().nullable(),
	txHash: z.string().nullable(),
	settlementSuccess: z.boolean().nullable(),
});

export const postX402AgentPaymentActivitySchemaOutput = z.object({
	agentIdentifier: z.string(),
	periodStart: z.date(),
	periodEnd: z.date(),
	Attempts: z.array(x402ActivityAttemptSchema),
});

type HandlerArgs = {
	input: z.infer<typeof postX402AgentPaymentActivitySchemaInput>;
	ctx: AuthContext;
};

export const getX402AgentPaymentActivity = x402ActivityEndpointFactory.build({
	method: 'post',
	input: postX402AgentPaymentActivitySchemaInput,
	output: postX402AgentPaymentActivitySchemaOutput,
	handler: withEarningsConcurrency(async ({ input, ctx }: HandlerArgs) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		if (input.agentIdentifier.trim() === '') {
			throw createHttpError(400, 'agentIdentifier is required');
		}

		await assertRegistryAgentInWalletScope(ctx, input.network, input.agentIdentifier);

		return listX402AgentPaymentActivity({
			network: input.network,
			agentIdentifier: input.agentIdentifier,
			startDate: input.startDate,
			endDate: input.endDate,
			take: input.take,
		});
	}),
});
