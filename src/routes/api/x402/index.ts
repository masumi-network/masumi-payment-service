import {
	adminAuthenticatedEndpointFactory,
	payAuthenticatedEndpointFactory,
	type AuthContext,
} from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import {
	createX402ManagedWallet,
	createX402Payment,
	deleteX402ManagedWallet,
	listX402ManagedWallets,
	listX402Networks,
	listX402PaymentAttempts,
	listX402Settlements,
	listX402WalletBudgets,
	setX402WalletBudget,
	settleX402Payment,
	upsertX402Network,
	verifyX402Payment,
} from '@masumi/payment-source-x402';
import {
	budgetSchema,
	createPaymentSchemaInput,
	createPaymentSchemaOutput,
	createWalletSchemaInput,
	createWalletSchemaOutput,
	deleteWalletSchemaInput,
	deleteWalletSchemaOutput,
	listBudgetSchemaInput,
	listBudgetSchemaOutput,
	listNetworksSchemaOutput,
	listPaymentAttemptsSchemaInput,
	listPaymentAttemptsSchemaOutput,
	listSettlementsSchemaInput,
	listSettlementsSchemaOutput,
	listWalletsSchemaOutput,
	setBudgetSchemaInput,
	settleSchemaOutput,
	upsertNetworkSchemaInput,
	verifySchemaOutput,
	verifySettleSchemaInput,
	x402NetworkSchema,
} from './schemas';

function serializeBudget(budget: {
	id: string;
	apiKeyId: string;
	evmWalletId: string;
	caip2Network: string;
	asset: string;
	remainingAmount: bigint;
	spentAmount: bigint;
	createdById: string | null;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		...budget,
		remainingAmount: budget.remainingAmount.toString(),
		spentAmount: budget.spentAmount.toString(),
	};
}

function serializePaymentAttempt(attempt: Awaited<ReturnType<typeof listX402PaymentAttempts>>[number]) {
	return {
		...attempt,
		amount: attempt.amount.toString(),
		Settlement: attempt.Settlement
			? { ...attempt.Settlement, amount: attempt.Settlement.amount?.toString() ?? null }
			: null,
	};
}

function serializeSettlement(settlement: Awaited<ReturnType<typeof listX402Settlements>>[number]) {
	return {
		...settlement,
		amount: settlement.amount?.toString() ?? null,
	};
}

export const verifyX402Post = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: verifySettleSchemaInput,
	output: verifySchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof verifySettleSchemaInput>; ctx: AuthContext }) =>
		verifyX402Payment({
			apiKeyId: ctx.id,
			caip2NetworkLimit: ctx.caip2NetworkLimit,
			supportedPaymentSourceId: input.supportedPaymentSourceId,
			paymentPayload: input.paymentPayload as Parameters<typeof verifyX402Payment>[0]['paymentPayload'],
		}),
});

export const settleX402Post = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: verifySettleSchemaInput,
	output: settleSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof verifySettleSchemaInput>; ctx: AuthContext }) =>
		settleX402Payment({
			apiKeyId: ctx.id,
			caip2NetworkLimit: ctx.caip2NetworkLimit,
			supportedPaymentSourceId: input.supportedPaymentSourceId,
			paymentPayload: input.paymentPayload as Parameters<typeof settleX402Payment>[0]['paymentPayload'],
		}),
});

export const createX402PaymentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createPaymentSchemaInput,
	output: createPaymentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createPaymentSchemaInput>; ctx: AuthContext }) =>
		createX402Payment({
			apiKeyId: ctx.id,
			caip2NetworkLimit: ctx.caip2NetworkLimit,
			evmWalletId: input.evmWalletId,
			paymentRequired: input.paymentRequired as Parameters<typeof createX402Payment>[0]['paymentRequired'],
			preferredNetwork: input.preferredNetwork,
			preferredAsset: input.preferredAsset,
			paymentIdentifier: input.paymentIdentifier,
		}),
});

export const listX402WalletsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: z.object({}),
	output: listWalletsSchemaOutput,
	handler: async () => ({
		Wallets: await listX402ManagedWallets(),
	}),
});

export const createX402WalletPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createWalletSchemaInput,
	output: createWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createWalletSchemaInput>; ctx: AuthContext }) =>
		createX402ManagedWallet({
			createdByApiKeyId: ctx.id,
			privateKey: input.privateKey,
		}),
});

export const deleteX402WalletPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: deleteWalletSchemaInput,
	output: deleteWalletSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof deleteWalletSchemaInput> }) => deleteX402ManagedWallet(input.id),
});

export const listX402NetworksGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: z.object({}),
	output: listNetworksSchemaOutput,
	handler: async () => ({
		Networks: await listX402Networks(),
	}),
});

export const upsertX402NetworkPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: upsertNetworkSchemaInput,
	output: x402NetworkSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof upsertNetworkSchemaInput>; ctx: AuthContext }) =>
		upsertX402Network({ ...input, createdById: ctx.id }),
});

export const listX402BudgetsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listBudgetSchemaInput,
	output: listBudgetSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof listBudgetSchemaInput> }) => ({
		Budgets: (await listX402WalletBudgets(input.apiKeyId)).map(serializeBudget),
	}),
});

export const setX402BudgetPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: setBudgetSchemaInput,
	output: budgetSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof setBudgetSchemaInput>; ctx: AuthContext }) =>
		serializeBudget(await setX402WalletBudget({ ...input, createdById: ctx.id })),
});

export const listX402PaymentAttemptsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listPaymentAttemptsSchemaInput,
	output: listPaymentAttemptsSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof listPaymentAttemptsSchemaInput> }) => ({
		PaymentAttempts: (await listX402PaymentAttempts(input)).map(serializePaymentAttempt),
	}),
});

export const listX402SettlementsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listSettlementsSchemaInput,
	output: listSettlementsSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof listSettlementsSchemaInput> }) => ({
		Settlements: (await listX402Settlements(input)).map(serializeSettlement),
	}),
});
