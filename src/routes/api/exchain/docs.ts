// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import { exchainReadTokenSchemaInput, exchainReadTokenSchemaOutput } from '@/routes/api/exchain/schemas';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

export function registerExchainPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	registry.registerPath({
		method: 'post',
		path: '/exchain/read-token',
		description:
			"Mints a read token for Exchain's embedded page for the guarded wallet configured on this node (MAS-596 demo). The node's Exchain token stays on the server; the returned token is read-only, scoped to that one wallet and valid for 15 minutes, and the returned url already carries it. Call again whenever the embedded page asks for a refresh. Answers 503 when EXCHAIN_WALLET_ID, EXCHAIN_COSIGN_API_KEY or NEXT_PUBLIC_EXCHAIN_DASHBOARD_URL is not set.",
		summary: 'Mint a read token for the embedded Exchain page. (admin access required)',
		tags: ['exchain'],
		security: secured,
		request: {
			body: {
				description: 'No fields; the wallet is fixed by node configuration',
				content: { 'application/json': { schema: exchainReadTokenSchemaInput.openapi({ example: {} }) } },
			},
		},
		responses: {
			200: successResponse('Read token minted', exchainReadTokenSchemaOutput, {
				walletId: 'wal_01M366RSC4JSAS8DGKPQV9M2WZ',
				url: 'https://cosign.exchain.network/protected/wal_01M366RSC4JSAS8DGKPQV9M2WZ?t=rt_example',
				token: 'rt_example',
				expiresAt: '2026-09-23T04:57:40Z',
			}),
			401: { description: 'Unauthorized' },
			502: { description: 'Exchain could not be reached or refused the request' },
			503: { description: 'Exchain co-signing is not configured on this node' },
		},
	});
}
