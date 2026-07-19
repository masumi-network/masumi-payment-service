import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
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
	handler: async ({ input, ctx }) => {
		const take = input.take ?? 20;

		const requests = await prisma.fundDistributionRequest.findMany({
			where: {
				...(input.fundWalletId ? { fundWalletId: input.fundWalletId } : {}),
				...(input.status ? { status: input.status } : {}),
				// Requests are unassigned until dispatch, so the target wallet is the
				// authoritative source relation for both queued and claimed rows. The
				// network and wallet-scope filters are defense-in-depth, matching the
				// sibling wallet endpoints in case this ever moves to a narrower
				// factory.
				TargetWallet: {
					AND: [buildHotWalletScopeFilter(ctx.walletScopeIds)],
					...(input.paymentSourceId ? { paymentSourceId: input.paymentSourceId } : {}),
					PaymentSource: { network: { in: ctx.networkLimit } },
				},
			},
			orderBy: { createdAt: 'desc' },
			take,
			// Cursor-inclusive, matching every other list endpoint here: the cursor
			// row is returned again and clients dedupe. Deliberate -- don't add
			// `skip: 1` to "fix" it without changing the others too.
			...(input.cursorId ? { cursor: { id: input.cursorId } } : {}),
			select: {
				id: true,
				createdAt: true,
				updatedAt: true,
				fundWalletId: true,
				targetWalletId: true,
				priority: true,
				assetUnit: true,
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
