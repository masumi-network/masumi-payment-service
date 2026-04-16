import { z } from '@/utils/zod-openapi';
import { FundDistributionPriority, FundDistributionStatus } from '@/generated/prisma/client';

const fundDistributionRequestSchema = z.object({
	id: z.string().describe('Distribution request id'),
	createdAt: z.date().describe('When the request was created'),
	updatedAt: z.date().describe('When the request was last updated'),
	fundWalletId: z.string().describe('Id of the fund wallet sending the funds'),
	targetWalletId: z.string().describe('Id of the wallet receiving the funds'),
	priority: z.nativeEnum(FundDistributionPriority).describe('Warning = batched, Critical = immediate'),
	amount: z.string().describe('Amount sent in lovelace'),
	status: z.nativeEnum(FundDistributionStatus).describe('Current status of the distribution request'),
	txHash: z.string().nullable().describe('On-chain transaction hash. Null until submitted'),
	error: z.string().nullable().describe('Error message if the distribution failed'),
	batchId: z.string().nullable().describe('Groups requests sent in the same transaction'),
});

export const getFundDistributionSchemaInput = z.object({
	paymentSourceId: z.string().min(1).max(250).optional().describe('Filter by payment source'),
	fundWalletId: z.string().min(1).max(250).optional().describe('Filter by fund wallet'),
	status: z.nativeEnum(FundDistributionStatus).optional().describe('Filter by status'),
	take: z.number().int().min(1).max(100).default(20).optional().describe('Number of results (max 100, default 20)'),
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
		triggered: z.boolean().describe('Whether the distribution cycle was triggered'),
	})
	.openapi('FundDistributionTriggered');
