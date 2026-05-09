import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { prisma } from '@/utils/db';
import { HotWalletType } from '@/generated/prisma/client';
import { logger } from '@/utils/logger';
import { fundDistributionService } from '@/services/wallets';
import {
	getFundDistributionSchemaInput,
	getFundDistributionSchemaOutput,
	triggerFundDistributionSchemaInput,
	triggerFundDistributionSchemaOutput,
} from './schemas';

export {
	getFundDistributionSchemaInput,
	getFundDistributionSchemaOutput,
	triggerFundDistributionSchemaInput,
	triggerFundDistributionSchemaOutput,
};

export const getFundDistributionEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getFundDistributionSchemaInput,
	output: getFundDistributionSchemaOutput,
	handler: async ({ input }) => {
		const take = input.take ?? 20;

		// If filtering by paymentSourceId, first resolve the fund wallet id
		let resolvedFundWalletId = input.fundWalletId;
		if (input.paymentSourceId && !resolvedFundWalletId) {
			const fundWallet = await prisma.hotWallet.findFirst({
				where: {
					paymentSourceId: input.paymentSourceId,
					type: HotWalletType.Funding,
					deletedAt: null,
				},
				select: { id: true },
			});
			resolvedFundWalletId = fundWallet?.id;
		}

		const requests = await prisma.fundDistributionRequest.findMany({
			where: {
				...(resolvedFundWalletId ? { fundWalletId: resolvedFundWalletId } : {}),
				...(input.status ? { status: input.status } : {}),
			},
			orderBy: { createdAt: 'desc' },
			take,
			...(input.cursorId ? { cursor: { id: input.cursorId }, skip: 1 } : {}),
			select: {
				id: true,
				createdAt: true,
				updatedAt: true,
				fundWalletId: true,
				targetWalletId: true,
				priority: true,
				amount: true,
				status: true,
				txHash: true,
				error: true,
				batchId: true,
			},
		});

		return {
			FundDistributions: requests.map((r) => ({
				...r,
				amount: r.amount.toString(),
			})),
		};
	},
});

export const triggerFundDistributionEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: triggerFundDistributionSchemaInput,
	output: triggerFundDistributionSchemaOutput,
	handler: async () => {
		const alreadyRunning = fundDistributionService.isRunning();

		// Run cycle asynchronously — don't await to avoid blocking the request
		fundDistributionService.processDistributionCycle().catch((error: unknown) => {
			logger.error('Fund distribution cycle failed via manual trigger', {
				component: 'fund_distribution',
				error: error instanceof Error ? error.message : String(error),
			});
		});

		return { triggered: true, alreadyRunning };
	},
});
