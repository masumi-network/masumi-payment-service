import { z } from '@masumi/payment-core/zod';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { querySimpleApiDiffSchemaInput, querySimpleApiDiffSchemaOutput } from '../schemas';
import { getSimpleApiListingsDiff } from '../queries';
import { serializeSimpleApiListings } from '../serializers';

export const querySimpleApiDiffGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: querySimpleApiDiffSchemaInput,
	output: querySimpleApiDiffSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof querySimpleApiDiffSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const { listings, cursor } = await getSimpleApiListingsDiff({
			network: input.network,
			statusUpdatedAfter: input.statusUpdatedAfter,
			limit: input.limit,
			cursorId: input.cursorId,
		});

		return {
			SimpleApiListings: serializeSimpleApiListings(listings),
			cursor: cursor ?? null,
		};
	},
});
