import { trace } from '@opentelemetry/api';
import { Address, Transaction, Value } from '@emurgo/cardano-serialization-lib-nodejs';
import { HotWalletType, Network } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';
import { prisma } from '@/utils/db';
import { CONFIG, type LowBalanceDefaultRule } from '@/utils/config';
import { logger } from '@/utils/logger';
import { logWarn } from '@/utils/logs';
import { recordWalletLowBalanceAlert } from '@/utils/metrics';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { webhookEventsService } from '@/services/webhook-handler/webhook-events.service';

type BalanceMap = Map<string, bigint>;

type WalletLowBalanceRuleRecord = {
	id: string;
	assetUnit: string;
	thresholdAmount: bigint;
	enabled: boolean;
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

type MeshLikeUtxo = {
	output: {
		amount: Array<{
			unit: string;
			quantity: string;
		}>;
	};
};

type LucidLikeUtxo = {
	assets: Record<string, bigint>;
};

type ProjectableMeshLikeUtxo = {
	input: {
		txHash: string;
		outputIndex: number;
	};
	output: {
		amount: Array<{
			unit: string;
			quantity: string;
		}>;
	};
};

type ProjectableLucidLikeUtxo = {
	txHash: string;
	outputIndex: number;
	assets: Record<string, bigint>;
};

type ProjectableWalletUtxo = ProjectableMeshLikeUtxo | ProjectableLucidLikeUtxo;

type ProjectedSubmissionEvaluation = {
	hotWalletId: string;
	walletAddress: string;
	walletUtxos: ProjectableWalletUtxo[];
	unsignedTx: string;
	checkSource: WalletBalanceCheckSource;
};

const LOW_BALANCE_WARNING_EVENT = 'wallet.low_balance';

function describeCheckSource(checkSource: WalletBalanceCheckSource): string {
	return checkSource === 'interval_check' ? 'interval check' : 'submission';
}

function statusForBalance(currentAmount: bigint, thresholdAmount: bigint): LowBalanceStatus {
	return currentAmount < thresholdAmount ? LowBalanceStatus.Low : LowBalanceStatus.Healthy;
}

function addQuantity(balanceMap: BalanceMap, assetUnit: string, quantity: bigint) {
	balanceMap.set(assetUnit, (balanceMap.get(assetUnit) ?? 0n) + quantity);
}

function subtractQuantity(balanceMap: BalanceMap, assetUnit: string, quantity: bigint) {
	balanceMap.set(assetUnit, (balanceMap.get(assetUnit) ?? 0n) - quantity);
}

function toBalanceMapFromMeshUtxos(utxos: MeshLikeUtxo[]): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	for (const utxo of utxos) {
		for (const amount of utxo.output.amount) {
			const assetUnit = amount.unit === '' ? 'lovelace' : amount.unit;
			addQuantity(balanceMap, assetUnit, BigInt(amount.quantity));
		}
	}

	return balanceMap;
}

function toBalanceMapFromLucidUtxos(utxos: LucidLikeUtxo[]): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	for (const utxo of utxos) {
		for (const [assetUnit, quantity] of Object.entries(utxo.assets)) {
			addQuantity(balanceMap, assetUnit === '' ? 'lovelace' : assetUnit, quantity);
		}
	}

	return balanceMap;
}

function isLucidProjectableUtxo(utxo: ProjectableWalletUtxo): utxo is ProjectableLucidLikeUtxo {
	return 'assets' in utxo;
}

function createUtxoReferenceKey(txHash: string, outputIndex: number): string {
	return `${txHash}#${outputIndex}`;
}

function toBalanceMapFromProjectableUtxo(utxo: ProjectableWalletUtxo): BalanceMap {
	if (isLucidProjectableUtxo(utxo)) {
		return toBalanceMapFromLucidUtxos([utxo]);
	}

	return toBalanceMapFromMeshUtxos([utxo]);
}

function toBalanceMapFromProjectableUtxos(utxos: ProjectableWalletUtxo[]): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	for (const utxo of utxos) {
		const utxoBalanceMap = toBalanceMapFromProjectableUtxo(utxo);

		for (const [assetUnit, quantity] of utxoBalanceMap) {
			addQuantity(balanceMap, assetUnit, quantity);
		}
	}

	return balanceMap;
}

function toBalanceMapFromCardanoValue(value: Value): BalanceMap {
	const balanceMap = new Map<string, bigint>();

	addQuantity(balanceMap, 'lovelace', BigInt(value.coin().to_str()));

	const multiAsset = value.multiasset();
	if (multiAsset == null) {
		return balanceMap;
	}

	const policyIds = multiAsset.keys();
	for (let policyIndex = 0; policyIndex < policyIds.len(); policyIndex++) {
		const policyId = policyIds.get(policyIndex);
		const assets = multiAsset.get(policyId);
		if (assets == null) {
			continue;
		}

		const assetNames = assets.keys();
		for (let assetIndex = 0; assetIndex < assetNames.len(); assetIndex++) {
			const assetName = assetNames.get(assetIndex);
			const quantity = assets.get(assetName);
			if (quantity == null) {
				continue;
			}

			addQuantity(balanceMap, `${policyId.to_hex()}${assetName.to_hex()}`, BigInt(quantity.to_str()));
		}
	}

	return balanceMap;
}

function projectBalanceMapFromUnsignedTx(
	walletAddress: string,
	walletUtxos: ProjectableWalletUtxo[],
	unsignedTx: string,
): BalanceMap {
	const projectedBalanceMap = toBalanceMapFromProjectableUtxos(walletUtxos);
	const knownWalletInputs = new Map<string, BalanceMap>();

	for (const utxo of walletUtxos) {
		const referenceKey = isLucidProjectableUtxo(utxo)
			? createUtxoReferenceKey(utxo.txHash, utxo.outputIndex)
			: createUtxoReferenceKey(utxo.input.txHash, utxo.input.outputIndex);
		knownWalletInputs.set(referenceKey, toBalanceMapFromProjectableUtxo(utxo));
	}

	const walletAddressHex = Address.from_bech32(walletAddress).to_hex();
	const transaction = Transaction.from_bytes(Buffer.from(unsignedTx, 'hex'));
	const transactionBody = transaction.body();
	const inputs = transactionBody.inputs();

	for (let inputIndex = 0; inputIndex < inputs.len(); inputIndex++) {
		const input = inputs.get(inputIndex);
		const inputBalanceMap = knownWalletInputs.get(createUtxoReferenceKey(input.transaction_id().to_hex(), input.index()));

		if (inputBalanceMap == null) {
			continue;
		}

		for (const [assetUnit, quantity] of inputBalanceMap) {
			subtractQuantity(projectedBalanceMap, assetUnit, quantity);
		}
	}

	const outputs = transactionBody.outputs();
	for (let outputIndex = 0; outputIndex < outputs.len(); outputIndex++) {
		const output = outputs.get(outputIndex);
		if (output.address().to_hex() !== walletAddressHex) {
			continue;
		}

		for (const [assetUnit, quantity] of toBalanceMapFromCardanoValue(output.amount())) {
			addQuantity(projectedBalanceMap, assetUnit, quantity);
		}
	}

	return projectedBalanceMap;
}

function getNetworkDefaultLowBalanceRules(network: Network): LowBalanceDefaultRule[] {
	return network === Network.Mainnet
		? CONFIG.LOW_BALANCE_DEFAULT_RULES_MAINNET
		: CONFIG.LOW_BALANCE_DEFAULT_RULES_PREPROD;
}

function serializeLowBalanceRecord(rule: WalletLowBalanceRuleRecord) {
	return {
		id: rule.id,
		assetUnit: rule.assetUnit,
		thresholdAmount: rule.thresholdAmount.toString(),
		enabled: rule.enabled,
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

	async evaluateProjectedHotWalletById({
		hotWalletId,
		walletAddress,
		walletUtxos,
		unsignedTx,
		checkSource,
	}: ProjectedSubmissionEvaluation): Promise<void> {
		const currentBalanceMap = toBalanceMapFromProjectableUtxos(walletUtxos);

		try {
			const projectedBalanceMap = projectBalanceMapFromUnsignedTx(walletAddress, walletUtxos, unsignedTx);
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
	): Promise<void> {
		if (wallet.LowBalanceRules.length === 0) {
			return;
		}

		const checkedAt = new Date();

		const alerts = await prisma.$transaction(async (tx) => {
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
									lastAlertedAt: checkedAt,
								},
							});

							if (result.count === 1) {
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
		});

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
				Secret: {
					select: {
						encryptedMnemonic: true,
					},
				},
				PaymentSource: {
					select: {
						id: true,
						network: true,
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

		await Promise.allSettled(
			wallets.map(async (wallet) => {
				if (wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey == null) {
					logger.warn('Skipping low balance monitoring for wallet without provider configuration', {
						wallet_id: wallet.id,
						payment_source_id: wallet.PaymentSource.id,
					});
					return;
				}

				const { utxos } = await generateWalletExtended(
					wallet.PaymentSource.network,
					wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
					wallet.Secret.encryptedMnemonic,
				);

				await this.evaluateWalletContext(
					wallet,
					toBalanceMapFromMeshUtxos(utxos as MeshLikeUtxo[]),
					'interval_check',
				);
			}),
		);
	}

	private async emitLowBalanceAlert(alert: WalletLowBalanceAlert): Promise<void> {
		const checkSourceLabel = describeCheckSource(alert.checkSource);
		const attributes = {
			network: alert.wallet.PaymentSource.network,
			wallet_id: alert.wallet.id,
			wallet_vkey: alert.wallet.walletVkey,
			wallet_address: alert.wallet.walletAddress,
			wallet_type: alert.wallet.type,
			payment_source_id: alert.wallet.PaymentSource.id,
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
		});

		trace.getActiveSpan()?.addEvent(LOW_BALANCE_WARNING_EVENT, attributes);

		await webhookEventsService.triggerWalletLowBalance({
			ruleId: alert.ruleId,
			walletId: alert.wallet.id,
			walletAddress: alert.wallet.walletAddress,
			walletVkey: alert.wallet.walletVkey,
			walletType: alert.wallet.type,
			paymentSourceId: alert.wallet.PaymentSource.id,
			network: alert.wallet.PaymentSource.network,
			assetUnit: alert.assetUnit,
			thresholdAmount: alert.thresholdAmount,
			currentAmount: alert.currentAmount,
			checkedAt: alert.checkedAt.toISOString(),
		});
	}

	getSerializedRules(rules: WalletLowBalanceRuleRecord[]) {
		return rules.map(serializeLowBalanceRecord);
	}

	getSerializedSummary(rules: WalletLowBalanceRuleRecord[]) {
		return serializeLowBalanceSummary(rules);
	}
}

export const walletLowBalanceMonitorService = new WalletLowBalanceMonitorService();
export {
	getNetworkDefaultLowBalanceRules,
	projectBalanceMapFromUnsignedTx,
	serializeLowBalanceRecord,
	serializeLowBalanceSummary,
	toBalanceMapFromLucidUtxos,
	toBalanceMapFromMeshUtxos,
};
export type {
	BalanceMap,
	LucidLikeUtxo,
	MeshLikeUtxo,
	ProjectableLucidLikeUtxo,
	ProjectableMeshLikeUtxo,
	ProjectableWalletUtxo,
	WalletBalanceCheckSource,
	WalletLowBalanceContext,
	WalletLowBalanceRuleRecord,
};
