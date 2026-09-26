import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { exchainReadTokenSchemaInput, exchainReadTokenSchemaOutput } from './schemas';
import { mintExchainReadToken } from './service';

export { exchainReadTokenSchemaInput, exchainReadTokenSchemaOutput };

/** Admin only: the embedded Exchain page shows a guarded wallet's mandate and every decision on it. */
export const exchainReadTokenEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: exchainReadTokenSchemaInput,
	output: exchainReadTokenSchemaOutput,
	handler: async () => mintExchainReadToken(),
});
