import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { AuthContext } from '@masumi/payment-core/auth';
import {
	adminWalletSchema,
	paymentSourceOutputSchema,
	paymentSourceSchemaInput,
	paymentSourceSchemaOutput,
} from './schemas';
import { getPaymentSourcesForQuery } from './queries';
import { serializePaymentSourcesResponse } from './serializers';

export { adminWalletSchema, paymentSourceOutputSchema, paymentSourceSchemaInput, paymentSourceSchemaOutput };

export const paymentSourceEndpointGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: paymentSourceSchemaInput,
	output: paymentSourceSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof paymentSourceSchemaInput>; ctx: AuthContext }) => {
		const paymentSources = await getPaymentSourcesForQuery(input, ctx.networkLimit);
		return serializePaymentSourcesResponse(paymentSources);
	},
});
