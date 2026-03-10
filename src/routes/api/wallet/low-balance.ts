import createHttpError from 'http-errors';
import { HotWalletType, Network } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';
import { prisma } from '@/utils/db';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { serializeLowBalanceRecord } from '@/services/wallet-low-balance-monitor';
import {
	deleteWalletLowBalanceRuleSchemaInput,
	deleteWalletLowBalanceRuleSchemaOutput,
	getWalletLowBalanceRulesSchemaInput,
	getWalletLowBalanceRulesSchemaOutput,
	patchWalletLowBalanceRuleSchemaInput,
	patchWalletLowBalanceRuleSchemaOutput,
	postWalletLowBalanceRuleSchemaInput,
	postWalletLowBalanceRuleSchemaOutput,
} from './low-balance.schemas';

export {
	deleteWalletLowBalanceRuleSchemaInput,
	deleteWalletLowBalanceRuleSchemaOutput,
	getWalletLowBalanceRulesSchemaInput,
	getWalletLowBalanceRulesSchemaOutput,
	patchWalletLowBalanceRuleSchemaInput,
	patchWalletLowBalanceRuleSchemaOutput,
	postWalletLowBalanceRuleSchemaInput,
	postWalletLowBalanceRuleSchemaOutput,
} from './low-balance.schemas';

function serializeRuleWithWallet(rule: {
	id: string;
	assetUnit: string;
	thresholdAmount: bigint;
	enabled: boolean;
	status: LowBalanceStatus;
	lastKnownAmount: bigint | null;
	lastCheckedAt: Date | null;
	lastAlertedAt: Date | null;
	HotWallet: {
		id: string;
		walletVkey: string;
		walletAddress: string;
		type: HotWalletType;
		PaymentSource: {
			id: string;
			network: Network;
		};
	};
}) {
	const serializedRule = serializeLowBalanceRecord(rule);
	return {
		...serializedRule,
		walletId: rule.HotWallet.id,
		walletVkey: rule.HotWallet.walletVkey,
		walletAddress: rule.HotWallet.walletAddress,
		walletType: rule.HotWallet.type,
		paymentSourceId: rule.HotWallet.PaymentSource.id,
		network: rule.HotWallet.PaymentSource.network,
	};
}

export const getWalletLowBalanceRulesEndpointGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getWalletLowBalanceRulesSchemaInput,
	output: getWalletLowBalanceRulesSchemaOutput,
	handler: async ({ input, ctx }) => {
		const rules = await prisma.hotWalletLowBalanceRule.findMany({
			where: {
				...(input.onlyLow ? { status: LowBalanceStatus.Low } : {}),
				...(input.includeDisabled ? {} : { enabled: true }),
				HotWallet: {
					AND: [buildHotWalletScopeFilter(ctx.walletScopeIds), ...(input.walletId ? [{ id: input.walletId }] : [])],
					deletedAt: null,
					PaymentSource: {
						deletedAt: null,
						network: { in: ctx.networkLimit },
						...(input.paymentSourceId ? { id: input.paymentSourceId } : {}),
					},
				},
			},
			orderBy: [{ hotWalletId: 'asc' }, { assetUnit: 'asc' }],
			include: {
				HotWallet: {
					select: {
						id: true,
						walletVkey: true,
						walletAddress: true,
						type: true,
						PaymentSource: {
							select: {
								id: true,
								network: true,
							},
						},
					},
				},
			},
		});

		return {
			Rules: rules.map(serializeRuleWithWallet),
		};
	},
});

export const postWalletLowBalanceRuleEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postWalletLowBalanceRuleSchemaInput,
	output: postWalletLowBalanceRuleSchemaOutput,
	handler: async ({ input, ctx }) => {
		const wallet = await prisma.hotWallet.findFirst({
			where: {
				AND: [buildHotWalletScopeFilter(ctx.walletScopeIds), { id: input.walletId }],
				deletedAt: null,
				PaymentSource: {
					deletedAt: null,
					network: { in: ctx.networkLimit },
				},
			},
			select: {
				id: true,
				walletVkey: true,
				walletAddress: true,
				type: true,
				PaymentSource: {
					select: {
						id: true,
						network: true,
					},
				},
			},
		});

		if (wallet == null) {
			throw createHttpError(404, 'Wallet not found');
		}

		const existingRule = await prisma.hotWalletLowBalanceRule.findUnique({
			where: {
				hotWalletId_assetUnit: {
					hotWalletId: input.walletId,
					assetUnit: input.assetUnit,
				},
			},
		});

		if (existingRule != null) {
			throw createHttpError(409, 'Low balance rule for this wallet and asset already exists');
		}

		const createdRule = await prisma.hotWalletLowBalanceRule.create({
			data: {
				hotWalletId: input.walletId,
				assetUnit: input.assetUnit,
				thresholdAmount: BigInt(input.thresholdAmount),
				enabled: input.enabled,
			},
		});

		return serializeRuleWithWallet({
			...createdRule,
			HotWallet: wallet,
		});
	},
});

export const patchWalletLowBalanceRuleEndpointPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: patchWalletLowBalanceRuleSchemaInput,
	output: patchWalletLowBalanceRuleSchemaOutput,
	handler: async ({ input, ctx }) => {
		const existingRule = await prisma.hotWalletLowBalanceRule.findFirst({
			where: {
				id: input.ruleId,
				HotWallet: {
					deletedAt: null,
					...buildHotWalletScopeFilter(ctx.walletScopeIds),
					PaymentSource: {
						deletedAt: null,
						network: { in: ctx.networkLimit },
					},
				},
			},
			include: {
				HotWallet: {
					select: {
						id: true,
						walletVkey: true,
						walletAddress: true,
						type: true,
						PaymentSource: {
							select: {
								id: true,
								network: true,
							},
						},
					},
				},
			},
		});

		if (existingRule == null || existingRule.HotWallet == null) {
			throw createHttpError(404, 'Low balance rule not found');
		}

		if (input.thresholdAmount == null && input.enabled == null) {
			throw createHttpError(400, 'No low balance rule changes requested');
		}

		const updatedRule = await prisma.hotWalletLowBalanceRule.update({
			where: {
				id: input.ruleId,
			},
			data: {
				thresholdAmount: input.thresholdAmount != null ? BigInt(input.thresholdAmount) : undefined,
				enabled: input.enabled,
			},
		});

		return serializeRuleWithWallet({
			...updatedRule,
			HotWallet: existingRule.HotWallet,
		});
	},
});

export const deleteWalletLowBalanceRuleEndpointDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteWalletLowBalanceRuleSchemaInput,
	output: deleteWalletLowBalanceRuleSchemaOutput,
	handler: async ({ input, ctx }) => {
		const existingRule = await prisma.hotWalletLowBalanceRule.findFirst({
			where: {
				id: input.ruleId,
				HotWallet: {
					deletedAt: null,
					...buildHotWalletScopeFilter(ctx.walletScopeIds),
					PaymentSource: {
						deletedAt: null,
						network: { in: ctx.networkLimit },
					},
				},
			},
			select: {
				id: true,
			},
		});

		if (existingRule == null) {
			throw createHttpError(404, 'Low balance rule not found');
		}

		await prisma.hotWalletLowBalanceRule.delete({
			where: {
				id: input.ruleId,
			},
		});

		return {
			ruleId: input.ruleId,
			deletedAt: new Date(),
		};
	},
});
