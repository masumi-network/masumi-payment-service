import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import { transformBigIntAmounts } from '@/utils/shared/transformers';
import { isPaymentBillable } from '../shared';

export const getUninvoicedPaymentsSchemaInput = z.object({
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.describe('Target month in format YYYY-MM (UTC calendar)'),
	buyerWalletVkey: z.string().max(1000).optional().describe('Optional buyer wallet vkey filter'),
	cursorId: z.string().optional().describe('Cursor for pagination (PaymentRequest id)'),
	limit: z.coerce.number().min(1).max(100).default(10).describe('Number of results to return'),
});

export const getUninvoicedPaymentsSchemaOutput = z.object({
	UninvoicedPayments: z.array(
		z.object({
			id: z.string(),
			blockchainIdentifier: z.string(),
			onChainState: z.string().nullable(),
			createdAt: z.date(),
			finalizedAt: z.date(),
			buyerWalletVkey: z.string().nullable(),
			buyerWalletAddress: z.string().nullable(),
			sellerWalletVkey: z.string().nullable(),
			sellerWalletAddress: z.string().nullable(),
			RequestedFunds: z.array(
				z.object({
					unit: z.string(),
					amount: z.string(),
				}),
			),
		}),
	),
});

export const getUninvoicedPaymentsEndpoint = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getUninvoicedPaymentsSchemaInput,
	output: getUninvoicedPaymentsSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof getUninvoicedPaymentsSchemaInput> }) => {
		const [yearStr, monthStr] = input.month.split('-');
		const year = Number(yearStr);
		const monthIdx = Number(monthStr) - 1;
		const monthStart = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
		const nextMonthStart = new Date(Date.UTC(year, monthIdx + 1, 1, 0, 0, 0, 0));
		const nowMs = BigInt(Date.now());

		const payments = await prisma.paymentRequest.findMany({
			where: {
				invoiceBaseId: null,
				...(input.buyerWalletVkey ? { BuyerWallet: { walletVkey: input.buyerWalletVkey } } : {}),
				...(input.cursorId ? { id: { lt: input.cursorId } } : {}),
				OR: [
					{
						onChainState: 'ResultSubmitted',
						unlockTime: { lte: nowMs },
						onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
					},
					{
						onChainState: 'Withdrawn',
						onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
					},
					{
						onChainState: 'DisputedWithdrawn',
						onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
					},
				],
			},
			include: {
				BuyerWallet: true,
				SmartContractWallet: true,
				RequestedFunds: true,
				WithdrawnForSeller: true,
				TransactionHistory: { select: { txHash: true } },
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
		});

		const billable = payments.filter(isPaymentBillable);

		const result = billable.map((payment) => {
			return {
				id: payment.id,
				blockchainIdentifier: payment.blockchainIdentifier,
				onChainState: payment.onChainState,
				createdAt: payment.createdAt,
				finalizedAt: payment.onChainStateOrResultLastChangedAt,
				buyerWalletVkey: payment.BuyerWallet?.walletVkey ?? null,
				buyerWalletAddress: payment.BuyerWallet?.walletAddress ?? null,
				sellerWalletVkey: payment.SmartContractWallet?.walletVkey ?? null,
				sellerWalletAddress: payment.SmartContractWallet?.walletAddress ?? null,
				RequestedFunds: transformBigIntAmounts(payment.RequestedFunds),
			};
		});

		return { UninvoicedPayments: result };
	},
});
