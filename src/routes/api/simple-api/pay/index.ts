import { z } from '@/utils/zod-openapi';
import { Prisma, SimpleApiStatus } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { settleX402Payment } from '@/utils/x402-facilitator';
import { CONFIG } from '@/utils/config';
import { paySimpleApiSchemaInput, paySimpleApiSchemaOutput } from '../schemas';

export const paySimpleApiPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: paySimpleApiSchemaInput,
	output: paySimpleApiSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof paySimpleApiSchemaInput>; ctx: AuthContext }) => {
		const listing = await prisma.simpleApiListing.findUnique({
			where: { id: input.listingId },
		});

		if (listing == null) {
			throw createHttpError(404, 'SimpleApi listing not found');
		}

		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, listing.network);

		if (listing.status === SimpleApiStatus.Deregistered) {
			throw createHttpError(400, 'SimpleApi listing is deregistered and cannot be paid');
		}

		if (listing.network === 'Mainnet' && !CONFIG.X402_FACILITATOR_URL_IS_EXPLICIT) {
			throw createHttpError(503, 'X402_FACILITATOR_URL must be explicitly configured for Mainnet payments');
		}

		const rawAcceptsArray: Prisma.JsonArray = Array.isArray(listing.rawAccepts) ? listing.rawAccepts : [];

		const acceptEntry = rawAcceptsArray.find((entry): entry is Prisma.JsonObject => {
			if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return false;
			return typeof entry.network === 'string' && entry.network === input.paymentNetwork;
		});

		if (acceptEntry == null) {
			const safeNetwork = input.paymentNetwork.slice(0, 50);
			throw createHttpError(400, `No payment option found for network '${safeNetwork}' on this listing`);
		}

		const scheme = typeof acceptEntry.scheme === 'string' ? acceptEntry.scheme : 'exact';
		const payTo = typeof acceptEntry.payTo === 'string' ? acceptEntry.payTo : '';
		const asset = typeof acceptEntry.asset === 'string' ? acceptEntry.asset : '';
		const resource = typeof acceptEntry.resource === 'string' ? acceptEntry.resource : '';

		if (input.authorization.to.toLowerCase() !== payTo.toLowerCase()) {
			throw createHttpError(400, `authorization.to must match the listing payTo address (${payTo})`);
		}

		const { settlementId, xPaymentHeader } = await settleX402Payment({
			facilitatorUrl: CONFIG.X402_FACILITATOR_URL,
			scheme,
			network: input.paymentNetwork,
			authorization: input.authorization,
			signature: input.signature,
		});

		const record = await prisma.simpleApiPaymentRecord.create({
			data: {
				listingId: listing.id,
				registryListingId: listing.registryListingId,
				requestedById: ctx.id,
				paymentNetwork: input.paymentNetwork,
				paymentScheme: scheme,
				amountPaid: input.authorization.value,
				payTo,
				asset,
				resource,
				facilitatorSettlementId: settlementId || null,
				xPaymentHeader,
			},
		});

		return {
			xPaymentHeader,
			paymentRecordId: record.id,
		};
	},
});
