import createHttpError from 'http-errors';
import { adminAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { exchainWalletIdFor } from '../wallet/guarded/service';
import { exchainReadTokenSchemaInput, exchainReadTokenSchemaOutput } from './schemas';
import { mintExchainReadToken } from './service';

export { exchainReadTokenSchemaInput, exchainReadTokenSchemaOutput };

/** Admin only: the embedded Exchain page shows a guarded wallet's mandate and every decision on it. */
export const exchainReadTokenEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: exchainReadTokenSchemaInput,
	output: exchainReadTokenSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof exchainReadTokenSchemaInput>; ctx: AuthContext }) => {
		if (input.hotWalletId == null) return mintExchainReadToken();
		const walletId = await exchainWalletIdFor(input.hotWalletId, ctx);
		if (walletId == null) throw createHttpError(404, 'This hot wallet has no registered Exchain wallet');
		return mintExchainReadToken(walletId);
	},
});
