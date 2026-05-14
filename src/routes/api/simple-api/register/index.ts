import { z } from '@/utils/zod-openapi';
import createHttpError from 'http-errors';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { CONFIG } from '@/utils/config';
import { registerSimpleApiSchemaInput, registerSimpleApiSchemaOutput, simpleApiListingSchema } from '../schemas';

interface RegistryCreateBody {
	network: string;
	url: string;
	name: string;
	description?: string;
	category?: string;
	tags?: string[];
}

interface RegistryCreateResponse {
	status?: string;
	error?: string;
	data?: {
		listing?: z.infer<typeof simpleApiListingSchema>;
	};
}

export const registerSimpleApiPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: registerSimpleApiSchemaInput,
	output: registerSimpleApiSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof registerSimpleApiSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		if (!CONFIG.REGISTRY_SERVICE_URL) {
			throw createHttpError(503, 'REGISTRY_SERVICE_URL is not configured');
		}

		const registryUrl = `${CONFIG.REGISTRY_SERVICE_URL}/api/v1/simple-api-listing`;

		const body: RegistryCreateBody = {
			network: input.network,
			url: input.url,
			name: input.name,
		};
		if (input.description !== undefined) body.description = input.description;
		if (input.category !== undefined) body.category = input.category;
		if (input.tags !== undefined && input.tags.length > 0) body.tags = input.tags;

		let response: Response;
		try {
			response = await fetch(registryUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					token: CONFIG.REGISTRY_API_KEY,
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw createHttpError(502, `Registry service unreachable: ${message}`);
		}

		let payload: RegistryCreateResponse;
		try {
			payload = (await response.json()) as RegistryCreateResponse;
		} catch {
			throw createHttpError(502, 'Registry service returned a non-JSON response');
		}

		if (!response.ok) {
			const errorMessage =
				typeof payload.error === 'string' ? payload.error : `Registry returned status ${response.status}`;
			throw createHttpError(response.status >= 500 ? 502 : response.status, errorMessage);
		}

		const listing = payload.data?.listing;

		if (!listing || typeof listing !== 'object') {
			throw createHttpError(502, 'Registry returned an unexpected response shape');
		}

		return { listing };
	},
});
