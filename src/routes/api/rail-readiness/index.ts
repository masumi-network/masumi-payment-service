import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { railReadinessSchemaInput, railReadinessSchemaOutput } from './schemas';
import { loadCardanoReadinessInput, loadX402ReadinessInput } from './queries';
import { evaluateCardanoReadiness, evaluateX402Readiness } from './service';

export { railReadinessSchemaInput, railReadinessSchemaOutput };

/**
 * One place that answers "is this rail actually set up?".
 *
 * Both the x402 setup wizard and the payment-sources card used to derive this
 * client-side from separate list endpoints, and disagreed with each other and
 * with the backend (e.g. whether a missing RPC URL still counted as a working
 * facilitator). Setup steps now only report complete when the server says so.
 *
 * Read auth: this exposes configuration presence, not secrets — no keys,
 * addresses or URLs are returned, only booleans and short explanations.
 */
export const railReadinessEndpointGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: railReadinessSchemaInput,
	output: railReadinessSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof railReadinessSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const [cardanoInput, x402Input] = await Promise.all([
			loadCardanoReadinessInput(input.network),
			loadX402ReadinessInput(input.network),
		]);

		return {
			network: input.network,
			Rails: [evaluateCardanoReadiness(cardanoInput), evaluateX402Readiness(x402Input)],
		};
	},
});
