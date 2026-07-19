import { trace } from '@opentelemetry/api';
import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { logWarn } from '@/utils/logs';
import { recordWalletLowBalanceAlert } from '@masumi/payment-core/metrics';
import { webhookEventsService } from '@/services/webhooks';
import { fetchAddressBalanceMap } from '@/services/shared/address-balance';
import { projectBalanceMapFromUnsignedTx, type BalanceMap, type ProjectableWalletUtxo } from './balance-map';
import {
	createRuleForWallet as createLowBalanceRuleForWallet,
	deleteRule as deleteLowBalanceRule,
	seedDefaultRulesForWallets as seedDefaultLowBalanceRulesForWallets,
	updateRule as updateLowBalanceRule,
	type WalletLowBalanceRuleMutationRecord,
} from './rule-mutations';

type WalletLowBalanceRuleRecord = {
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
};

type WalletLowBalanceContext = {
	id: string;
	walletVkey: string;
	walletAddress: string;
	type: HotWalletType;
	PaymentSource: {
		id: string;
		network: Network;
		paymentSourceType: PaymentSourceType;
	};
	LowBalanceRules: WalletLowBalanceRuleRecord[];
};

type WalletLowBalanceAlert = {
	ruleId: string;
	assetUnit: string;
	thresholdAmount: string;
	currentAmount: string;
	checkedAt: Date;
	wallet: WalletLowBalanceContext;
	checkSource: WalletBalanceCheckSource;
};

type WalletBalanceCheckSource = 'interval_check' | 'submission';

type EvaluateWalletContextOptions = {
	emitAlerts?: boolean;
};

type ProjectedSubmissionEvaluation = {
	hotWalletId: string;
	walletAddress: string;
	walletUtxos: ProjectableWalletUtxo[];
	unsignedTx: string;
	checkSource: WalletBalanceCheckSource;
	currentBalanceMap?: BalanceMap;
};

const LOW_BALANCE_WARNING_EVENT = 'wallet.low_balance';
const SCHEDULED_MONITORING_CONCURRENCY = 5;

function describeCheckSource(checkSource: WalletBalanceCheckSource): string {
	return checkSource === 'interval_check' ? 'interval check' : 'submission';
}

function statusForBalance(currentAmount: bigint, thresholdAmount: bigint): LowBalanceStatus {
	return currentAmount < thresholdAmount ? LowBalanceStatus.Low : LowBalanceStatus.Healthy;
}

function serializeLowBalanceRecord(rule: WalletLowBalanceRuleRecord) {
	return {
		id: rule.id,
		assetUnit: rule.assetUnit,
		thresholdAmount: rule.thresholdAmount.toString(),
		enabled: rule.enabled,
		topupEnabled: rule.topupEnabled,
		topupAmount: rule.topupAmount?.toString() ?? null,
		status: rule.status,
		lastKnownAmount: rule.lastKnownAmount?.toString() ?? null,
		lastCheckedAt: rule.lastCheckedAt,
		lastAlertedAt: rule.lastAlertedAt,
	};
}

function serializeLowBalanceSummary(rules: WalletLowBalanceRuleRecord[]) {
	const lowRules = rules.filter((rule) => rule.enabled && rule.status === LowBalanceStatus.Low);
	const lastCheckedAt =
		rules
			.map((rule) => rule.lastCheckedAt)
			.filter((value): value is Date => value != null)
			.sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

	return {
		isLow: lowRules.length > 0,
		lowRuleCount: lowRules.length,
		lastCheckedAt,
	};
}

export class WalletLowBalanceMonitorService {
	async getWalletLowBalanceContext(hotWalletId: string): Promise<WalletLowBalanceContext | null> {
		return prisma.hotWallet.findFirst({
			where: {
				id: hotWalletId,
				deletedAt: null,
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
						paymentSourceType: true,
					},
				},
				LowBalanceRules: {
					where: {
						enabled: true,
					},
					orderBy: [{ assetUnit: 'asc' }],
					select: {
						id: true,
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
				},
			},
		});
	}

	async seedDefaultRulesForWallets(walletIds: string[]): Promise<void> {
		return seedDefaultLowBalanceRulesForWallets(walletIds);
	}

	async createRuleForWallet(params: {
		hotWalletId: string;
		assetUnit: string;
		thresholdAmount: bigint;
		enabled: boolean;
		topupEnabled?: boolean;
		topupAmount?: bigint | null;
	}): Promise<WalletLowBalanceRuleMutationRecord> {
		return createLowBalanceRuleForWallet(this, params);
	}

	async updateRule(params: {
		ruleId: string;
		thresholdAmount?: bigint;
		enabled?: boolean;
		topupEnabled?: boolean;
		topupAmount?: bigint | null;
	}): Promise<WalletLowBalanceRuleMutationRecord> {
		return updateLowBalanceRule(this, params);
	}

	async deleteRule(ruleId: string): Promise<void> {
		return deleteLowBalanceRule(ruleId);
	}

	async evaluateHotWalletById(
		hotWalletId: string,
		balanceMap: BalanceMap,
		checkSource: WalletBalanceCheckSource,
	): Promise<void> {
		const wallet = await this.getWalletLowBalanceContext(hotWalletId);
		if (wallet == null || wallet.LowBalanceRules.length === 0) {
			return;
		}

		await this.evaluateWalletContext(wallet, balanceMap, checkSource);
	}

	async evaluateCurrentHotWalletById(
		hotWalletId: string,
		checkSource: WalletBalanceCheckSource,
	): Promise<BalanceMap | null> {
		const balanceMap = await this.fetchCurrentBalanceMapForWallet(hotWalletId);
		if (balanceMap == null) {
			return null;
		}

		await this.evaluateHotWalletById(hotWalletId, balanceMap, checkSource);
		return balanceMap;
	}

	async evaluateProjectedHotWalletById({
		hotWalletId,
		walletAddress,
		walletUtxos,
		unsignedTx,
		checkSource,
		currentBalanceMap: providedCurrentBalanceMap,
	}: ProjectedSubmissionEvaluation): Promise<void> {
		const currentBalanceMap =
			providedCurrentBalanceMap == null
				? await this.fetchCurrentBalanceMapForWallet(hotWalletId)
				: new Map(providedCurrentBalanceMap);
		if (currentBalanceMap == null) {
			logger.warn('Skipping projected wallet balance evaluation because the confirmed balance is unavailable', {
				component: 'wallet_low_balance_monitor',
				operation: 'projected_balance_skip',
				wallet_id: hotWalletId,
				check_source: checkSource,
			});
			return;
		}

		try {
			const projectedBalanceMap = projectBalanceMapFromUnsignedTx(
				walletAddress,
				walletUtxos,
				unsignedTx,
				currentBalanceMap,
			);
			await this.evaluateHotWalletById(hotWalletId, projectedBalanceMap, checkSource);
		} catch (error) {
			logger.warn('Failed to project post-submission wallet balance, falling back to current balance monitoring', {
				component: 'wallet_low_balance_monitor',
				wallet_id: hotWalletId,
				check_source: checkSource,
				error: error instanceof Error ? error.message : String(error),
			});
			await this.evaluateHotWalletById(hotWalletId, currentBalanceMap, checkSource);
		}
	}

	async evaluateWalletContext(
		wallet: WalletLowBalanceContext,
		balanceMap: BalanceMap,
		checkSource: WalletBalanceCheckSource,
		options?: EvaluateWalletContextOptions,
	): Promise<void> {
		if (wallet.LowBalanceRules.length === 0) {
			return;
		}

		const emitAlerts = options?.emitAlerts ?? true;
		const checkedAt = new Date();

		const alerts = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						const detectedAlerts: WalletLowBalanceAlert[] = [];

						for (const rule of wallet.LowBalanceRules) {
							const currentAmount = balanceMap.get(rule.assetUnit) ?? 0n;
							const nextStatus = statusForBalance(currentAmount, rule.thresholdAmount);
							const commonUpdate = {
								lastKnownAmount: currentAmount,
								lastCheckedAt: checkedAt,
							};

							switch (rule.status) {
								case LowBalanceStatus.Unknown: {
									await tx.hotWalletLowBalanceRule.updateMany({
										where: {
											id: rule.id,
											status: LowBalanceStatus.Unknown,
										},
										data: {
											...commonUpdate,
											status: nextStatus,
											lastAlertedAt: null,
										},
									});
									break;
								}
								case LowBalanceStatus.Healthy: {
									if (nextStatus === LowBalanceStatus.Low) {
										const result = await tx.hotWalletLowBalanceRule.updateMany({
											where: {
												id: rule.id,
												status: LowBalanceStatus.Healthy,
											},
											data: {
												...commonUpdate,
												status: LowBalanceStatus.Low,
												lastAlertedAt: emitAlerts ? checkedAt : null,
											},
										});

										if (emitAlerts && result.count === 1) {
											detectedAlerts.push({
												ruleId: rule.id,
												assetUnit: rule.assetUnit,
												thresholdAmount: rule.thresholdAmount.toString(),
												currentAmount: currentAmount.toString(),
												checkedAt,
												wallet,
												checkSource,
											});
										}
									} else {
										await tx.hotWalletLowBalanceRule.updateMany({
											where: {
												id: rule.id,
												status: LowBalanceStatus.Healthy,
											},
											data: commonUpdate,
										});
									}
									break;
								}
								case LowBalanceStatus.Low: {
									await tx.hotWalletLowBalanceRule.updateMany({
										where: {
											id: rule.id,
											status: LowBalanceStatus.Low,
										},
										data: {
											...commonUpdate,
											status: nextStatus,
										},
									});
									break;
								}
								default: {
									const exhaustiveStatus: never = rule.status;
									throw new Error(`Unhandled low balance status: ${String(exhaustiveStatus)}`);
								}
							}
						}

						return detectedAlerts;
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'low-balance-0' },
		);

		await Promise.all(alerts.map(async (alert) => this.emitLowBalanceAlert(alert)));
	}

	async runScheduledMonitoringCycle(): Promise<void> {
		const wallets = await prisma.hotWallet.findMany({
			where: {
				deletedAt: null,
				LowBalanceRules: {
					some: {
						enabled: true,
					},
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
						paymentSourceType: true,
						PaymentSourceConfig: {
							select: {
								rpcProviderApiKey: true,
							},
						},
					},
				},
				LowBalanceRules: {
					where: {
						enabled: true,
					},
					orderBy: [{ assetUnit: 'asc' }],
					select: {
						id: true,
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
				},
			},
		});

		if (wallets.length === 0) {
			return;
		}

		let checkedWalletCount = 0;
		let skippedWalletCount = 0;
		let failedWalletCount = 0;
		let nextWalletIndex = 0;

		const runWorker = async () => {
			while (nextWalletIndex < wallets.length) {
				const wallet = wallets[nextWalletIndex];
				nextWalletIndex += 1;

				try {
					if (wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey == null) {
						skippedWalletCount += 1;
						logger.warn('Skipping low balance monitoring for wallet without provider configuration', {
							component: 'wallet_low_balance_monitor',
							operation: 'scheduled_monitoring_skip',
							wallet_id: wallet.id,
							payment_source_id: wallet.PaymentSource.id,
						});
						continue;
					}

					const balanceMap = await fetchAddressBalanceMap({
						network: wallet.PaymentSource.network,
						rpcProviderApiKey: wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
						address: wallet.walletAddress,
					});

					await this.evaluateWalletContext(wallet, balanceMap, 'interval_check');
					checkedWalletCount += 1;
				} catch (error) {
					failedWalletCount += 1;
					logger.error('Scheduled low balance monitoring failed for wallet', {
						component: 'wallet_low_balance_monitor',
						operation: 'scheduled_monitoring_error',
						wallet_id: wallet.id,
						payment_source_id: wallet.PaymentSource.id,
						network: wallet.PaymentSource.network,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		};

		await Promise.all(
			Array.from({ length: Math.min(SCHEDULED_MONITORING_CONCURRENCY, wallets.length) }, async () => runWorker()),
		);

		logger.info('Completed scheduled low balance monitoring cycle', {
			component: 'wallet_low_balance_monitor',
			operation: 'scheduled_monitoring_summary',
			total_wallet_count: wallets.length,
			checked_wallet_count: checkedWalletCount,
			skipped_wallet_count: skippedWalletCount,
			failed_wallet_count: failedWalletCount,
			concurrency_limit: Math.min(SCHEDULED_MONITORING_CONCURRENCY, wallets.length),
		});
	}

	private async emitLowBalanceAlert(alert: WalletLowBalanceAlert): Promise<void> {
		const checkSourceLabel = describeCheckSource(alert.checkSource);
		const paymentSourceType = alert.wallet.PaymentSource.paymentSourceType;
		if (paymentSourceType == null) {
			logger.error('PaymentSource has null paymentSourceType while emitting low-balance alert; skipping alert', {
				paymentSourceId: alert.wallet.PaymentSource.id,
				walletId: alert.wallet.id,
				checkSource: alert.checkSource,
			});
			return;
		}
		const attributes = {
			network: alert.wallet.PaymentSource.network,
			wallet_id: alert.wallet.id,
			wallet_vkey: alert.wallet.walletVkey,
			wallet_address: alert.wallet.walletAddress,
			wallet_type: alert.wallet.type,
			payment_source_id: alert.wallet.PaymentSource.id,
			payment_source_type: paymentSourceType,
			asset_unit: alert.assetUnit,
			threshold_amount: alert.thresholdAmount,
			current_amount: alert.currentAmount,
			checked_at: alert.checkedAt.toISOString(),
			check_source: alert.checkSource,
			check_source_label: checkSourceLabel,
		};

		logWarn(
			`Wallet entered low balance during ${checkSourceLabel}`,
			{
				component: 'wallet_low_balance_monitor',
				operation: 'wallet_low_balance_warning',
			},
			attributes,
		);

		recordWalletLowBalanceAlert({
			network: alert.wallet.PaymentSource.network,
			asset_unit: alert.assetUnit,
			wallet_type: alert.wallet.type,
			check_source: alert.checkSource,
			payment_source_type: paymentSourceType,
		});

		trace.getActiveSpan()?.addEvent(LOW_BALANCE_WARNING_EVENT, attributes);

		await webhookEventsService.triggerWalletLowBalance({
			ruleId: alert.ruleId,
			walletId: alert.wallet.id,
			walletAddress: alert.wallet.walletAddress,
			walletVkey: alert.wallet.walletVkey,
			walletType: alert.wallet.type,
			paymentSourceId: alert.wallet.PaymentSource.id,
			paymentSourceType,
			network: alert.wallet.PaymentSource.network,
			assetUnit: alert.assetUnit,
			thresholdAmount: alert.thresholdAmount,
			currentAmount: alert.currentAmount,
			checkedAt: alert.checkedAt.toISOString(),
		});

		// Auto-top-up is driven by the fund-distribution scan, which reads each
		// rule's topupEnabled/threshold/amount directly. The monitor's job here is
		// the alert/webhook above; it no longer requests top-ups itself.
	}

	getSerializedRules(rules: WalletLowBalanceRuleRecord[]) {
		return rules.map(serializeLowBalanceRecord);
	}

	getSerializedSummary(rules: WalletLowBalanceRuleRecord[]) {
		return serializeLowBalanceSummary(rules);
	}

	async fetchCurrentBalanceMapForWallet(hotWalletId: string): Promise<BalanceMap | null> {
		const wallet = await prisma.hotWallet.findFirst({
			where: {
				id: hotWalletId,
				deletedAt: null,
			},
			select: {
				id: true,
				walletAddress: true,
				PaymentSource: {
					select: {
						id: true,
						network: true,
						paymentSourceType: true,
						PaymentSourceConfig: {
							select: {
								rpcProviderApiKey: true,
							},
						},
					},
				},
			},
		});

		if (wallet == null) {
			return null;
		}

		const rpcProviderApiKey = wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
		if (rpcProviderApiKey == null) {
			logger.warn('Skipping immediate low balance rule refresh without provider configuration', {
				component: 'wallet_low_balance_monitor',
				operation: 'rule_refresh_skip',
				wallet_id: wallet.id,
				payment_source_id: wallet.PaymentSource.id,
			});
			return null;
		}

		try {
			return await fetchAddressBalanceMap({
				network: wallet.PaymentSource.network,
				rpcProviderApiKey,
				address: wallet.walletAddress,
			});
		} catch (error) {
			logger.warn('Failed to fetch current wallet balance', {
				component: 'wallet_low_balance_monitor',
				operation: 'current_balance_fetch_error',
				wallet_id: wallet.id,
				payment_source_id: wallet.PaymentSource.id,
				network: wallet.PaymentSource.network,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
}

export const walletLowBalanceMonitorService = new WalletLowBalanceMonitorService();
export { projectBalanceMapFromUnsignedTx, toBalanceMapFromLucidUtxos, toBalanceMapFromMeshUtxos } from './balance-map';
export type {
	BalanceMap,
	LucidLikeUtxo,
	MeshLikeUtxo,
	ProjectableLucidLikeUtxo,
	ProjectableMeshLikeUtxo,
	ProjectableWalletUtxo,
} from './balance-map';
export { getNetworkDefaultLowBalanceRules } from './rule-mutations';
export { serializeLowBalanceRecord, serializeLowBalanceSummary };
export type {
	EvaluateWalletContextOptions,
	WalletBalanceCheckSource,
	WalletLowBalanceContext,
	WalletLowBalanceRuleRecord,
};
