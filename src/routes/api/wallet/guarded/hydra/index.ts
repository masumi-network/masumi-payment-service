import { adminAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prepareGuardedDeposit, submitGuardedDeposit } from './deposit';
import {
	getGuardedHydraSchemaInput,
	getGuardedHydraSchemaOutput,
	postGuardedHydraDepositSchemaInput,
	postGuardedHydraDepositSchemaOutput,
	postGuardedHydraSubmitSchemaInput,
	postGuardedHydraSubmitSchemaOutput,
	postGuardedHydraWithdrawSchemaInput,
	postGuardedHydraWithdrawSchemaOutput,
} from './schemas';
import { getGuardedHydraStatus } from './status';
import { prepareGuardedWithdraw, submitGuardedWithdraw } from './withdraw';

export const getGuardedHydraEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getGuardedHydraSchemaInput,
	output: getGuardedHydraSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getGuardedHydraSchemaInput>; ctx: AuthContext }) =>
		getGuardedHydraStatus(input.hotWalletId, ctx),
});

/** Owner-signed move into a head, step 1: returns the deposit for the owner to sign. */
export const postGuardedHydraDepositEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postGuardedHydraDepositSchemaInput,
	output: postGuardedHydraDepositSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postGuardedHydraDepositSchemaInput>; ctx: AuthContext }) =>
		prepareGuardedDeposit(input, ctx),
});

export const postGuardedHydraDepositSubmitEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postGuardedHydraSubmitSchemaInput,
	output: postGuardedHydraSubmitSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postGuardedHydraSubmitSchemaInput>; ctx: AuthContext }) =>
		submitGuardedDeposit(input, ctx),
});

/** Owner-signed move out of a head, step 1: returns the decommit for the owner to sign. */
export const postGuardedHydraWithdrawEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postGuardedHydraWithdrawSchemaInput,
	output: postGuardedHydraWithdrawSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postGuardedHydraWithdrawSchemaInput>; ctx: AuthContext }) =>
		prepareGuardedWithdraw(input, ctx),
});

export const postGuardedHydraWithdrawSubmitEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postGuardedHydraSubmitSchemaInput,
	output: postGuardedHydraSubmitSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postGuardedHydraSubmitSchemaInput>; ctx: AuthContext }) =>
		submitGuardedWithdraw(input, ctx),
});
