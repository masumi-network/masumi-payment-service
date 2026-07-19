import { z } from '@masumi/payment-core/zod';
import { FundDistributionPriority, FundDistributionStatus } from '@/generated/prisma/client';

const fundDistributionRequestSchema = z.object({
	id: z.string().describe('Distribution request id'),
	createdAt: z.date().describe('When the request was created'),
	updatedAt: z.date().describe('When the request was last updated'),
	fundWalletId: z
		.string()
		.nullable()
		.describe('Id of the fund wallet sending the funds. Null until a fund wallet claims the request'),
	targetWalletId: z.string().describe('Id of the wallet receiving the funds'),
	priority: z
		.nativeEnum(FundDistributionPriority)
		.describe('Legacy priority marker. New requests use Warning; both values are dispatched through the batch window'),
	assetUnit: z.string().describe('"lovelace" for ADA, otherwise policy id + hex asset name'),
	amount: z.string().describe("Amount sent in the asset's smallest unit"),
	status: z.nativeEnum(FundDistributionStatus).describe('Current status of the distribution request'),
	txHash: z.string().nullable().describe('On-chain transaction hash. Null until submitted'),
	error: z.string().nullable().describe('Error message if the distribution failed'),
	batchId: z.string().nullable().describe('Groups requests sent in the same transaction'),
});

export const getFundDistributionSchemaInput = z.object({
	paymentSourceId: z.string().min(1).max(250).optional().describe('Filter by payment source'),
	fundWalletId: z.string().min(1).max(250).optional().describe('Filter by fund wallet'),
	status: z.nativeEnum(FundDistributionStatus).optional().describe('Filter by status'),
	// z.coerce: GET inputs arrive as query-string values, which are always
	// strings; plain z.number() rejects every request that supplies the param.
	take: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.optional()
		.describe('Number of results (max 100, default 20)'),
	cursorId: z.string().min(1).max(250).optional().describe('Cursor id for pagination'),
});

export const getFundDistributionSchemaOutput = z
	.object({
		FundDistributions: z.array(fundDistributionRequestSchema).describe('List of distribution requests'),
	})
	.openapi('FundDistributionList');

export const triggerFundDistributionSchemaInput = z.object({});

export const triggerFundDistributionSchemaOutput = z
	.object({
		triggered: z.boolean().describe('Always true — indicates the request was received'),
		alreadyRunning: z
			.boolean()
			.describe('True if a distribution cycle was already in progress when this request arrived'),
	})
	.openapi('FundDistributionTriggered');
