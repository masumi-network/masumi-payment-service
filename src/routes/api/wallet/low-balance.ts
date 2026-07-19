import createHttpError from 'http-errors';
import { HotWalletType, Network } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';
import { prisma } from '@masumi/payment-core/db';
import { CONSTANTS } from '@masumi/payment-core/config';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { isCardanoNativeAssetUnit } from '@/utils/cardano/asset-unit';
import { serializeLowBalanceRecord, walletLowBalanceMonitorService } from '@/services/wallets';
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

function assertBuildableTopupConfig(params: {
	assetUnit: string;
	walletType: HotWalletType;
	topupEnabled: boolean;
	topupAmount: bigint | null;
}): void {
	const { assetUnit, walletType, topupEnabled, topupAmount } = params;
	if (!topupEnabled) return;

	if (walletType === HotWalletType.Funding) {
		throw createHttpError(400, 'Funding wallets cannot be configured as auto top-up targets');
	}

	if (topupAmount == null) {
		throw createHttpError(400, 'topupAmount is required when topupEnabled is true');
	}

	if (assetUnit === 'lovelace') {
		if (topupAmount < CONSTANTS.MIN_TOPUP_LOVELACE) {
			throw createHttpError(
				400,
				`ADA topupAmount must be at least ${CONSTANTS.MIN_TOPUP_LOVELACE.toString()} lovelace`,
			);
		}
		return;
	}

	if (!isCardanoNativeAssetUnit(assetUnit)) {
		throw createHttpError(
			400,
			'Auto top-up assetUnit must be lovelace or a 56-character policy id followed by an asset name of at most 32 bytes',
		);
	}
}

function serializeRuleWithWallet(rule: {
	id: string;
	assetUnit: string;
	thresholdAmount: bigint;
	enabled: boolean;
	topupEnabled: boolean;
	topupAmount: bigint | null;
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

export const getWalletLowBalanceRulesEndpointGet = adminAuthenticatedEndpointFactory.build({
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

		// A rule for a unit that matches no on-chain asset reads as balance 0 and
		// alerts "Low" forever — reject it up front for plain monitoring rules
		// too, not just when auto top-up is on.
		if (input.assetUnit !== 'lovelace' && !isCardanoNativeAssetUnit(input.assetUnit)) {
			throw createHttpError(
				400,
				'assetUnit must be lovelace or a 56-character policy id followed by an asset name of at most 32 bytes',
			);
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

		// Store topupAmount only alongside an enabled top-up: the output schema
		// documents it as null while auto top-up is off, and enabling later
		// re-validates whatever is submitted then.
		const topupAmount = input.topupEnabled && input.topupAmount != null ? BigInt(input.topupAmount) : null;
		assertBuildableTopupConfig({
			assetUnit: input.assetUnit,
			walletType: wallet.type,
			topupEnabled: input.topupEnabled,
			topupAmount,
		});

		const createdRule = await walletLowBalanceMonitorService.createRuleForWallet({
			hotWalletId: input.walletId,
			assetUnit: input.assetUnit,
			thresholdAmount: BigInt(input.thresholdAmount),
			enabled: input.enabled,
			topupEnabled: input.topupEnabled,
			topupAmount,
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

		if (
			input.thresholdAmount == null &&
			input.enabled == null &&
			input.topupEnabled == null &&
			input.topupAmount === undefined
		) {
			throw createHttpError(400, 'No low balance rule changes requested');
		}

		const nextTopupEnabled = input.topupEnabled ?? existingRule.topupEnabled;
		const nextTopupAmount =
			input.topupAmount === undefined
				? existingRule.topupAmount
				: input.topupAmount == null
					? null
					: BigInt(input.topupAmount);
		assertBuildableTopupConfig({
			assetUnit: existingRule.assetUnit,
			walletType: existingRule.HotWallet.type,
			topupEnabled: nextTopupEnabled,
			topupAmount: nextTopupAmount,
		});

		const updatedRule = await walletLowBalanceMonitorService.updateRule({
			ruleId: input.ruleId,
			thresholdAmount: input.thresholdAmount != null ? BigInt(input.thresholdAmount) : undefined,
			enabled: input.enabled,
			topupEnabled: input.topupEnabled,
			topupAmount:
				input.topupAmount === undefined ? undefined : input.topupAmount == null ? null : BigInt(input.topupAmount),
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

		await walletLowBalanceMonitorService.deleteRule(input.ruleId);

		return {
			ruleId: input.ruleId,
			deletedAt: new Date(),
		};
	},
});
