import { FundDistributionStatus, Network, type Prisma } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';
import createHttpError from 'http-errors';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { CONFIG, type LowBalanceDefaultRule } from '@masumi/payment-core/config';
import type { BalanceMap } from './balance-map';
import type {
	EvaluateWalletContextOptions,
	WalletBalanceCheckSource,
	WalletLowBalanceContext,
	WalletLowBalanceRuleRecord,
} from './service';

type WalletLowBalanceRuleMutationRecord = WalletLowBalanceRuleRecord & {
	hotWalletId: string;
};

type LowBalanceRuleMutationHost = {
	getWalletLowBalanceContext(hotWalletId: string): Promise<WalletLowBalanceContext | null>;
	evaluateWalletContext(
		wallet: WalletLowBalanceContext,
		balanceMap: BalanceMap,
		checkSource: WalletBalanceCheckSource,
		options?: EvaluateWalletContextOptions,
	): Promise<void>;
	fetchCurrentBalanceMapForWallet(hotWalletId: string): Promise<BalanceMap | null>;
};

async function retireUnclaimedTopupForRule(
	tx: Prisma.TransactionClient,
	rule: { hotWalletId: string; assetUnit: string },
	error: string,
): Promise<void> {
	await tx.fundDistributionRequest.updateMany({
		where: {
			targetWalletId: rule.hotWalletId,
			assetUnit: rule.assetUnit,
			status: FundDistributionStatus.Pending,
			fundWalletId: null,
			transactionId: null,
		},
		data: {
			status: FundDistributionStatus.Failed,
			error,
		},
	});
}

function getNetworkDefaultLowBalanceRules(network: Network): LowBalanceDefaultRule[] {
	return network === Network.Mainnet
		? CONFIG.LOW_BALANCE_DEFAULT_RULES_MAINNET
		: CONFIG.LOW_BALANCE_DEFAULT_RULES_PREPROD;
}

async function seedDefaultRulesForWallets(walletIds: string[]): Promise<void> {
	if (walletIds.length === 0) {
		return;
	}

	const wallets = await prisma.hotWallet.findMany({
		where: {
			id: { in: walletIds },
			deletedAt: null,
		},
		select: {
			id: true,
			PaymentSource: {
				select: {
					network: true,
				},
			},
		},
	});

	const rulesToCreate = wallets.flatMap((wallet) =>
		getNetworkDefaultLowBalanceRules(wallet.PaymentSource.network).map((rule) => ({
			hotWalletId: wallet.id,
			assetUnit: rule.assetUnit,
			thresholdAmount: BigInt(rule.thresholdAmount),
			enabled: true,
			status: LowBalanceStatus.Unknown,
		})),
	);

	if (rulesToCreate.length === 0) {
		return;
	}

	await prisma.hotWalletLowBalanceRule.createMany({
		data: rulesToCreate,
		skipDuplicates: true,
	});
}

async function createRuleForWallet(
	host: LowBalanceRuleMutationHost,
	params: {
		hotWalletId: string;
		assetUnit: string;
		thresholdAmount: bigint;
		enabled: boolean;
		topupEnabled?: boolean;
		topupAmount?: bigint | null;
	},
): Promise<WalletLowBalanceRuleMutationRecord> {
	const createdRule = await prisma.hotWalletLowBalanceRule.create({
		data: {
			hotWalletId: params.hotWalletId,
			assetUnit: params.assetUnit,
			thresholdAmount: params.thresholdAmount,
			enabled: params.enabled,
			topupEnabled: params.topupEnabled ?? false,
			topupAmount: params.topupAmount ?? null,
			status: LowBalanceStatus.Unknown,
			lastKnownAmount: null,
			lastCheckedAt: null,
			lastAlertedAt: null,
		},
		select: {
			id: true,
			hotWalletId: true,
			assetUnit: true,
			thresholdAmount: true,
			enabled: true,
			topupEnabled: true,
			topupAmount: true,
			status: true,
			lastKnownAmount: true,
			lastCheckedAt: true,
			lastAlertedAt: true,
		},
	});

	await refreshRuleStateAfterMutation(host, createdRule.hotWalletId, createdRule.enabled);

	return (await getRuleMutationRecordById(createdRule.id)) ?? createdRule;
}

async function updateRule(
	host: LowBalanceRuleMutationHost,
	params: {
		ruleId: string;
		thresholdAmount?: bigint;
		enabled?: boolean;
		topupEnabled?: boolean;
		topupAmount?: bigint | null;
	},
): Promise<WalletLowBalanceRuleMutationRecord> {
	const updatedRule = await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					const updated = await tx.hotWalletLowBalanceRule.update({
						where: {
							id: params.ruleId,
						},
						data: {
							thresholdAmount: params.thresholdAmount,
							enabled: params.enabled,
							topupEnabled: params.topupEnabled,
							topupAmount: params.topupAmount,
							status: LowBalanceStatus.Unknown,
							lastKnownAmount: null,
							lastCheckedAt: null,
							lastAlertedAt: null,
						},
						select: {
							id: true,
							hotWalletId: true,
							assetUnit: true,
							thresholdAmount: true,
							enabled: true,
							topupEnabled: true,
							topupAmount: true,
							status: true,
							lastKnownAmount: true,
							lastCheckedAt: true,
							lastAlertedAt: true,
						},
					});

					await retireUnclaimedTopupForRule(tx, updated, 'Distribution cancelled because its low-balance rule changed');
					return updated;
				},
				{ isolationLevel: 'Serializable' },
			),
		{ label: 'low-balance-rule-update' },
	);

	await refreshRuleStateAfterMutation(host, updatedRule.hotWalletId, updatedRule.enabled);

	return (await getRuleMutationRecordById(updatedRule.id)) ?? updatedRule;
}

async function deleteRule(ruleId: string): Promise<void> {
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						const deletedRule = await tx.hotWalletLowBalanceRule.delete({
							where: { id: ruleId },
							select: {
								hotWalletId: true,
								assetUnit: true,
							},
						});
						await retireUnclaimedTopupForRule(
							tx,
							deletedRule,
							'Distribution cancelled because its low-balance rule was deleted',
						);
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'low-balance-rule-delete' },
		);
	} catch (error) {
		// The route pre-checks existence, so P2025 here means a concurrent
		// delete won the race — a missing row, not a server fault.
		if ((error as { code?: string }).code === 'P2025') {
			throw createHttpError(404, 'Low balance rule not found');
		}
		throw error;
	}
}

async function getRuleMutationRecordById(ruleId: string): Promise<WalletLowBalanceRuleMutationRecord | null> {
	return prisma.hotWalletLowBalanceRule.findUnique({
		where: {
			id: ruleId,
		},
		select: {
			id: true,
			hotWalletId: true,
			assetUnit: true,
			thresholdAmount: true,
			enabled: true,
			topupEnabled: true,
			topupAmount: true,
			status: true,
			lastKnownAmount: true,
			lastCheckedAt: true,
			lastAlertedAt: true,
		},
	});
}

async function refreshRuleStateAfterMutation(
	host: LowBalanceRuleMutationHost,
	hotWalletId: string,
	enabled: boolean,
): Promise<void> {
	if (!enabled) {
		return;
	}

	const balanceMap = await host.fetchCurrentBalanceMapForWallet(hotWalletId);
	if (balanceMap == null) {
		return;
	}

	const wallet = await host.getWalletLowBalanceContext(hotWalletId);
	if (wallet == null || wallet.LowBalanceRules.length === 0) {
		return;
	}

	await host.evaluateWalletContext(wallet, balanceMap, 'interval_check', { emitAlerts: false });
}

export { createRuleForWallet, deleteRule, getNetworkDefaultLowBalanceRules, seedDefaultRulesForWallets, updateRule };
export type { LowBalanceRuleMutationHost, WalletLowBalanceRuleMutationRecord };
