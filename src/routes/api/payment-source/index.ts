import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import {
	adminWalletSchema,
	paymentSourceOutputSchema,
	paymentSourceSchemaInput,
	paymentSourceSchemaOutput,
	purchasingWalletSchema,
	sellingWalletSchema,
} from './schemas';
import { getPaymentSourcesForQuery } from './queries';
import { serializePaymentSourcesResponse } from './serializers';

export {
	adminWalletSchema,
	paymentSourceOutputSchema,
	paymentSourceSchemaInput,
	paymentSourceSchemaOutput,
	purchasingWalletSchema,
	sellingWalletSchema,
};

export const paymentSourceEndpointGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: paymentSourceSchemaInput,
	output: paymentSourceSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof paymentSourceSchemaInput>; ctx: AuthContext }) => {
		const paymentSources = await getPaymentSourcesForQuery(input, ctx.networkLimit, ctx.walletScopeIds);
		return serializePaymentSourcesResponse(paymentSources);
	},
});
