import { z } from '@/utils/zod-openapi';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import {
	querySimpleApiListingSchemaInput,
	querySimpleApiListingSchemaOutput,
	querySimpleApiCountSchemaInput,
	querySimpleApiCountSchemaOutput,
} from './schemas';
import { getSimpleApiListingsForQuery, countSimpleApiListings } from './queries';
import { serializeSimpleApiListings } from './serializers';

export {
	querySimpleApiListingSchemaInput,
	querySimpleApiListingSchemaOutput,
	querySimpleApiCountSchemaInput,
	querySimpleApiCountSchemaOutput,
};

export const querySimpleApiListingGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: querySimpleApiListingSchemaInput,
	output: querySimpleApiListingSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof querySimpleApiListingSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const listings = await getSimpleApiListingsForQuery({
			limit: input.limit,
			cursorId: input.cursorId,
			network: input.network,
			filterStatus: input.filterStatus,
			searchQuery: input.searchQuery,
		});

		return { SimpleApiListings: serializeSimpleApiListings(listings) };
	},
});

export const querySimpleApiCountGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: querySimpleApiCountSchemaInput,
	output: querySimpleApiCountSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof querySimpleApiCountSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const total = await countSimpleApiListings({
			network: input.network,
			filterStatus: input.filterStatus,
		});

		return { total };
	},
});
