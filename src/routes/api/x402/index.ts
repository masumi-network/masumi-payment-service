import {
	adminAuthenticatedEndpointFactory,
	payAuthenticatedEndpointFactory,
	type AuthContext,
} from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { webhookEventsService } from '@/services/webhooks/events.service';
import {
	countX402ManagedWallets,
	countX402PaymentAttempts,
	countX402Settlements,
	createX402ManagedWallet,
	createX402Payment,
	deleteX402LowBalanceRule,
	deleteX402ManagedWallet,
	getX402Analytics,
	getX402ManagedWallet,
	getX402WalletBalances,
	listX402LowBalanceRules,
	listX402ManagedWallets,
	listX402Networks,
	listX402PaymentAttempts,
	listX402Settlements,
	listX402WalletBudgets,
	setX402LowBalanceRule,
	reconcileX402PaymentAttempt,
	setX402WalletBudget,
	settleX402Payment,
	updateX402LowBalanceRule,
	updateX402ManagedWallet,
	upsertX402Network,
	verifyX402Payment,
} from '@masumi/payment-source-x402';
import {
	analyticsSchemaInput,
	analyticsSchemaOutput,
	budgetSchema,
	countSchemaOutput,
	createPaymentSchemaInput,
	createPaymentSchemaOutput,
	createWalletSchemaInput,
	createWalletSchemaOutput,
	deleteLowBalanceRuleSchemaInput,
	deleteLowBalanceRuleSchemaOutput,
	deleteWalletSchemaInput,
	deleteWalletSchemaOutput,
	listBudgetSchemaInput,
	listBudgetSchemaOutput,
	listLowBalanceRulesSchemaInput,
	listLowBalanceRulesSchemaOutput,
	listNetworksSchemaInput,
	listNetworksSchemaOutput,
	listPaymentAttemptsSchemaInput,
	listPaymentAttemptsSchemaOutput,
	listSettlementsSchemaInput,
	listSettlementsSchemaOutput,
	listWalletsSchemaInput,
	listWalletsSchemaOutput,
	lowBalanceRuleSchema,
	paymentAttemptsCountSchemaInput,
	reconcilePaymentSchemaInput,
	reconcilePaymentSchemaOutput,
	setBudgetSchemaInput,
	setLowBalanceRuleSchemaInput,
	settleSchemaOutput,
	settlementsCountSchemaInput,
	updateLowBalanceRuleSchemaInput,
	updateWalletSchemaInput,
	upsertNetworkSchemaInput,
	verifySchemaOutput,
	verifySettleSchemaInput,
	walletBalanceSchemaInput,
	walletBalanceSchemaOutput,
	walletDetailSchemaInput,
	walletSchemaOutput,
	walletsCountSchemaInput,
	x402NetworkSchema,
} from './schemas';

function serializeBudget(budget: {
	id: string;
	apiKeyId: string;
	evmWalletId: string;
	EvmWallet: { address: string };
	caip2Network: string;
	asset: string;
	remainingAmount: bigint;
	spentAmount: bigint;
	createdById: string | null;
	createdAt: Date;
	updatedAt: Date;
}) {
	const { EvmWallet, ...rest } = budget;
	return {
		...rest,
		evmWalletAddress: EvmWallet.address,
		remainingAmount: budget.remainingAmount.toString(),
		spentAmount: budget.spentAmount.toString(),
	};
}

function serializeLowBalanceRule(rule: Awaited<ReturnType<typeof listX402LowBalanceRules>>[number]) {
	const { EvmWallet, ...rest } = rule;
	return {
		...rest,
		evmWalletAddress: EvmWallet.address,
		thresholdAmount: rule.thresholdAmount.toString(),
		lastKnownAmount: rule.lastKnownAmount?.toString() ?? null,
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
	handler: async ({ input, ctx }: { input: z.infer<typeof verifySettleSchemaInput>; ctx: AuthContext }) => {
		const result = await settleX402Payment({
			apiKeyId: ctx.id,
			caip2NetworkLimit: ctx.caip2NetworkLimit,
			supportedPaymentSourceId: input.supportedPaymentSourceId,
			paymentPayload: input.paymentPayload as Parameters<typeof settleX402Payment>[0]['paymentPayload'],
		});
		// Notify subscribers of the settle outcome (a replay was already settled before, so
		// it does not re-fire). Fire-and-forget: webhook delivery must not block the response.
		if (!result.replay && result.webhook != null) {
			void webhookEventsService.triggerX402Payment(result.webhook.success, {
				...result.webhook,
				settledAt: new Date().toISOString(),
			});
		}
		return result;
	},
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
	input: listWalletsSchemaInput,
	output: listWalletsSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof listWalletsSchemaInput> }) => ({
		Wallets: await listX402ManagedWallets({ take: input.take, cursorId: input.cursorId, type: input.type }),
	}),
});

export const createX402WalletPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createWalletSchemaInput,
	output: createWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createWalletSchemaInput>; ctx: AuthContext }) =>
		createX402ManagedWallet({
			createdByApiKeyId: ctx.id,
			networkId: input.networkId,
			type: input.type,
			note: input.note,
			privateKey: input.privateKey,
		}),
});

export const getX402WalletGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: walletDetailSchemaInput,
	output: walletSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof walletDetailSchemaInput> }) => getX402ManagedWallet(input.id),
});

export const updateX402WalletPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: updateWalletSchemaInput,
	output: walletSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof updateWalletSchemaInput> }) =>
		updateX402ManagedWallet({ id: input.id, note: input.note }),
});

export const x402WalletBalanceGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: walletBalanceSchemaInput,
	output: walletBalanceSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof walletBalanceSchemaInput> }) =>
		getX402WalletBalances({ evmWalletId: input.id, caip2Network: input.caip2Network }),
});

export const x402WalletsCountGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: walletsCountSchemaInput,
	output: countSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof walletsCountSchemaInput> }) => ({
		total: await countX402ManagedWallets({ type: input.type }),
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
	input: listNetworksSchemaInput,
	output: listNetworksSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof listNetworksSchemaInput> }) => ({
		Networks: await listX402Networks({ isTestnet: input.isTestnet }),
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

export const reconcileX402PaymentPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: reconcilePaymentSchemaInput,
	output: reconcilePaymentSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof reconcilePaymentSchemaInput> }) =>
		reconcileX402PaymentAttempt(input),
});

export const listX402SettlementsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listSettlementsSchemaInput,
	output: listSettlementsSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof listSettlementsSchemaInput> }) => ({
		Settlements: (await listX402Settlements(input)).map(serializeSettlement),
	}),
});

export const listX402LowBalanceRulesGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listLowBalanceRulesSchemaInput,
	output: listLowBalanceRulesSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof listLowBalanceRulesSchemaInput> }) => ({
		Rules: (await listX402LowBalanceRules(input)).map(serializeLowBalanceRule),
	}),
});

export const setX402LowBalanceRulePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: setLowBalanceRuleSchemaInput,
	output: lowBalanceRuleSchema,
	handler: async ({ input }: { input: z.infer<typeof setLowBalanceRuleSchemaInput> }) =>
		serializeLowBalanceRule(await setX402LowBalanceRule(input)),
});

export const updateX402LowBalanceRulePatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: updateLowBalanceRuleSchemaInput,
	output: lowBalanceRuleSchema,
	handler: async ({ input }: { input: z.infer<typeof updateLowBalanceRuleSchemaInput> }) =>
		serializeLowBalanceRule(await updateX402LowBalanceRule(input)),
});

export const deleteX402LowBalanceRuleDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteLowBalanceRuleSchemaInput,
	output: deleteLowBalanceRuleSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof deleteLowBalanceRuleSchemaInput> }) =>
		deleteX402LowBalanceRule(input.ruleId),
});

export const x402PaymentAttemptsCountGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: paymentAttemptsCountSchemaInput,
	output: countSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof paymentAttemptsCountSchemaInput> }) => ({
		total: await countX402PaymentAttempts(input),
	}),
});

export const x402SettlementsCountGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: settlementsCountSchemaInput,
	output: countSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof settlementsCountSchemaInput> }) => ({
		total: await countX402Settlements(input),
	}),
});

export const x402AnalyticsPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: analyticsSchemaInput,
	output: analyticsSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof analyticsSchemaInput> }) => getX402Analytics(input),
});
