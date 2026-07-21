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
 * The gap this closes is mostly on the Cardano side: the payment-sources card
 * treated "a Web3CardanoV2 row exists" as "V2 is ready", so a source with no
 * selling wallet, no Blockfrost key, or a retired contract policy id still
 * rendered as configured. For x402 the win is narrower — see
 * evaluateX402Readiness — but keeping both rails behind one definition stops
 * the next consumer from inventing a third one.
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
