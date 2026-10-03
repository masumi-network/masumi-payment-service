import { adminAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import {
	deleteGuardedWalletSchemaInput,
	deleteGuardedWalletSchemaOutput,
	getGuardedWalletSchemaInput,
	getGuardedWalletSchemaOutput,
	postGuardedWalletSchemaInput,
	postGuardedWalletSchemaOutput,
} from './schemas';
import { attachGuardedWallet, detachGuardedWallet, getGuardedWallet } from './service';

/** Admin only: bind a Purchasing hot wallet to an Exchain co-signed smart wallet the owner minted. */
export const postGuardedWalletEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postGuardedWalletSchemaInput,
	output: postGuardedWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postGuardedWalletSchemaInput>; ctx: AuthContext }) =>
		attachGuardedWallet(input, ctx),
});

export const getGuardedWalletEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getGuardedWalletSchemaInput,
	output: getGuardedWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getGuardedWalletSchemaInput>; ctx: AuthContext }) =>
		getGuardedWallet(input.hotWalletId, ctx),
});

/** Detach only changes the node: the funds stay in the smart wallet, Exchain keeps its record. */
export const deleteGuardedWalletEndpointDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteGuardedWalletSchemaInput,
	output: deleteGuardedWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof deleteGuardedWalletSchemaInput>; ctx: AuthContext }) =>
		detachGuardedWallet(input.hotWalletId, ctx),
});
