import { createId } from '@paralleldrive/cuid2';
import {
	FundDistributionPriority,
	FundDistributionStatus,
	HotWalletType,
	LowBalanceStatus,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { CONSTANTS } from '@/utils/config';
import { logger } from '@/utils/logger';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { Mutex } from 'async-mutex';
import { withJobLock } from '@/services/shared/job-runner';
import { buildAndSubmitFundDistributionTx } from './transaction-builder';
import { webhookEventsService } from '@/services/webhooks';

type FundWalletContext = {
	id: string;
	walletAddress: string;
	walletVkey: string;
	lowBalanceRuleId: string;
	paymentSourceId: string;
	network: string;
	rpcProviderApiKey: string;
	encryptedMnemonic: string;
	config: {
		warningThreshold: bigint;
		criticalThreshold: bigint;
		topupAmount: bigint;
		batchWindowMs: number;
	};
};

const mutex = new Mutex();

async function getFundWalletForPaymentSource(paymentSourceId: string): Promise<FundWalletContext | null> {
	const fundWallet = await prisma.hotWallet.findFirst({
		where: {
			paymentSourceId,
			type: HotWalletType.Funding,
			deletedAt: null,
			FundDistributionConfig: {
				enabled: true,
			},
		},
		select: {
			id: true,
			walletAddress: true,
			walletVkey: true,
			paymentSourceId: true,
			LowBalanceRules: {
				where: { assetUnit: 'lovelace', enabled: true },
				select: { id: true },
				take: 1,
			},
			Secret: { select: { encryptedMnemonic: true } },
			PaymentSource: {
				select: {
					network: true,
					PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
				},
			},
			FundDistributionConfig: {
				select: {
					warningThreshold: true,
					criticalThreshold: true,
					topupAmount: true,
					batchWindowMs: true,
				},
			},
		},
	});

	if (
		!fundWallet ||
		!fundWallet.Secret ||
		!fundWallet.FundDistributionConfig ||
		!fundWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey
	) {
		return null;
	}

	return {
		id: fundWallet.id,
		walletAddress: fundWallet.walletAddress,
		walletVkey: fundWallet.walletVkey,
		lowBalanceRuleId: fundWallet.LowBalanceRules[0]?.id ?? '',
		paymentSourceId: fundWallet.paymentSourceId,
		network: fundWallet.PaymentSource.network,
		rpcProviderApiKey: fundWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: fundWallet.Secret.encryptedMnemonic,
		config: {
			warningThreshold: fundWallet.FundDistributionConfig.warningThreshold,
			criticalThreshold: fundWallet.FundDistributionConfig.criticalThreshold,
			topupAmount: fundWallet.FundDistributionConfig.topupAmount,
			batchWindowMs: fundWallet.FundDistributionConfig.batchWindowMs,
		},
	};
}

async function processRequestsForFundWallet(
	fundWallet: FundWalletContext,
	requests: Array<{ id: string; targetWalletId: string; targetAddress: string; amount: bigint }>,
): Promise<void> {
	if (requests.length === 0) return;

	// Get current balance via Blockfrost
	let fundWalletBalance: bigint;
	try {
		const { generateWalletExtended } = await import('@/utils/generator/wallet-generator');
		const { utxos } = await generateWalletExtended(
			fundWallet.network as Parameters<typeof generateWalletExtended>[0],
			fundWallet.rpcProviderApiKey,
			fundWallet.encryptedMnemonic,
		);
		const { toBalanceMapFromMeshUtxos } = await import('@/services/wallets');
		const balanceMap = toBalanceMapFromMeshUtxos(utxos);
		fundWalletBalance = balanceMap.get('lovelace') ?? 0n;
	} catch (error) {
		logger.error('Failed to fetch fund wallet balance', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			error: interpretBlockchainError(error),
		});
		return;
	}

	// Determine which requests we can actually fulfill given balance constraints
	const feeBuffer = CONSTANTS.MIN_TX_FEE_BUFFER_LOVELACE;
	let remainingBalance = fundWalletBalance - feeBuffer;

	if (remainingBalance <= 0n) {
		logger.warn('Fund wallet has insufficient balance for any distributions', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			balance: fundWalletBalance.toString(),
		});
		await webhookEventsService.triggerWalletLowBalance({
			ruleId: fundWallet.lowBalanceRuleId,
			walletId: fundWallet.id,
			walletAddress: fundWallet.walletAddress,
			walletVkey: fundWallet.walletVkey,
			walletType: HotWalletType.Funding,
			paymentSourceId: fundWallet.paymentSourceId,
			network: fundWallet.network as 'Mainnet' | 'Preprod',
			assetUnit: 'lovelace',
			thresholdAmount: '0',
			currentAmount: fundWalletBalance.toString(),
			checkedAt: new Date().toISOString(),
		});
		return;
	}

	const affordableRequests = requests.filter((req) => {
		if (req.amount <= remainingBalance) {
			remainingBalance -= req.amount;
			return true;
		}
		return false;
	});

	if (affordableRequests.length === 0) {
		logger.warn('Fund wallet cannot afford any pending distributions', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			balance: fundWalletBalance.toString(),
			first_request_amount: requests[0]?.amount.toString(),
		});
		return;
	}

	const batchId = createId();
	const outputs = affordableRequests.map((req) => ({ address: req.targetAddress, lovelace: req.amount }));

	// Atomically check the wallet is still unlocked, create the Transaction record, and lock the wallet.
	// All three steps run in a single DB transaction to eliminate the TOCTOU race.
	let transaction: { id: string };
	try {
		transaction = await prisma.$transaction(async (tx) => {
			const currentWallet = await tx.hotWallet.findUnique({
				where: { id: fundWallet.id },
				select: { lockedAt: true, pendingTransactionId: true },
			});

			if (currentWallet == null) {
				throw Object.assign(new Error('WALLET_NOT_FOUND'), { code: 'WALLET_NOT_FOUND' });
			}
			if (currentWallet.lockedAt != null || currentWallet.pendingTransactionId != null) {
				throw Object.assign(new Error('WALLET_LOCKED'), { code: 'WALLET_LOCKED' });
			}

			const newTx = await tx.transaction.create({
				data: {
					txHash: null,
					status: TransactionStatus.Pending,
				},
			});

			await tx.hotWallet.update({
				where: { id: fundWallet.id, deletedAt: null },
				data: {
					lockedAt: new Date(),
					pendingTransactionId: newTx.id,
				},
			});

			return newTx;
		});
	} catch (error) {
		if (error instanceof Error && (error as { code?: string }).code === 'WALLET_LOCKED') {
			logger.info('Fund wallet is locked, skipping distribution cycle', {
				component: 'fund_distribution',
				fund_wallet_id: fundWallet.id,
			});
			return;
		}
		if (error instanceof Error && (error as { code?: string }).code === 'WALLET_NOT_FOUND') {
			return;
		}
		throw error;
	}

	let txHash: string;
	try {
		const result = await buildAndSubmitFundDistributionTx({
			encryptedMnemonic: fundWallet.encryptedMnemonic,
			network: fundWallet.network as Parameters<typeof buildAndSubmitFundDistributionTx>[0]['network'],
			rpcProviderApiKey: fundWallet.rpcProviderApiKey,
			outputs,
		});
		txHash = result.txHash;
	} catch (error) {
		const errorMsg = interpretBlockchainError(error);
		logger.error('Fund distribution transaction failed', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			batch_id: batchId,
			error: errorMsg,
		});

		// Unlock wallet, delete orphaned transaction record, and mark requests as failed
		await prisma.$transaction([
			prisma.hotWallet.update({
				where: { id: fundWallet.id, deletedAt: null },
				data: { lockedAt: null, pendingTransactionId: null },
			}),
			prisma.transaction.delete({ where: { id: transaction.id } }),
		]);

		await prisma.fundDistributionRequest.updateMany({
			where: { id: { in: affordableRequests.map((r) => r.id) } },
			data: { status: FundDistributionStatus.Failed, error: errorMsg, batchId },
		});
		return;
	}

	// Update transaction with hash
	await prisma.transaction.update({
		where: { id: transaction.id },
		data: { txHash },
	});

	// Mark requests as submitted
	await prisma.fundDistributionRequest.updateMany({
		where: { id: { in: affordableRequests.map((r) => r.id) } },
		data: { status: FundDistributionStatus.Submitted, txHash, batchId },
	});

	logger.info('Fund distribution transaction submitted', {
		component: 'fund_distribution',
		fund_wallet_id: fundWallet.id,
		tx_hash: txHash,
		batch_id: batchId,
		recipient_count: affordableRequests.length,
	});

	// Trigger webhook
	await webhookEventsService.triggerFundDistributionSent({
		batchId,
		fundWalletId: fundWallet.id,
		fundWalletAddress: fundWallet.walletAddress,
		txHash,
		network: fundWallet.network as 'Mainnet' | 'Preprod',
		distributions: affordableRequests.map((req) => ({
			requestId: req.id,
			targetWalletId: req.targetWalletId,
			targetWalletAddress: req.targetAddress,
			amount: req.amount.toString(),
		})),
	});
}

export class FundDistributionService {
	isRunning(): boolean {
		return mutex.isLocked();
	}

	async requestTopup(params: {
		targetWalletId: string;
		currentBalance: bigint;
		paymentSourceId: string;
	}): Promise<void> {
		const { targetWalletId, currentBalance, paymentSourceId } = params;

		const fundWallet = await getFundWalletForPaymentSource(paymentSourceId);
		if (fundWallet == null) return;

		// Guard: fund wallet must not fund itself
		if (fundWallet.id === targetWalletId) return;

		const priority =
			currentBalance < fundWallet.config.criticalThreshold
				? FundDistributionPriority.Critical
				: FundDistributionPriority.Warning;

		// Use a serializable transaction to atomically check for an existing pending/submitted
		// request and create a new one. This prevents duplicate requests from concurrent calls
		// (e.g. scheduled cycle + low-balance alert firing simultaneously).
		let created = false;
		try {
			await prisma.$transaction(
				async (tx) => {
					const alreadyPending = await tx.fundDistributionRequest.findFirst({
						where: {
							fundWalletId: fundWallet.id,
							targetWalletId,
							status: { in: [FundDistributionStatus.Pending, FundDistributionStatus.Submitted] },
						},
						select: { id: true },
					});
					if (alreadyPending) return;

					await tx.fundDistributionRequest.create({
						data: {
							fundWalletId: fundWallet.id,
							targetWalletId,
							priority,
							amount: fundWallet.config.topupAmount,
							status: FundDistributionStatus.Pending,
						},
					});
					created = true;
				},
				{ isolationLevel: 'Serializable' },
			);
		} catch (error) {
			// P2034 = serialization conflict — a concurrent call already created the request
			if ((error as { code?: string }).code === 'P2034') {
				logger.debug('Skipping duplicate fund distribution request (serialization conflict)', {
					component: 'fund_distribution',
					target_wallet_id: targetWalletId,
				});
				return;
			}
			throw error;
		}

		if (!created) return;

		logger.info('Fund distribution request created', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			target_wallet_id: targetWalletId,
			priority,
			amount: fundWallet.config.topupAmount.toString(),
		});

		if (priority === FundDistributionPriority.Critical) {
			await withJobLock(mutex, 'fund_distribution_critical', async () => {
				const targetWallet = await prisma.hotWallet.findUnique({
					where: { id: targetWalletId },
					select: { walletAddress: true },
				});
				if (!targetWallet) return;

				const request = await prisma.fundDistributionRequest.findFirst({
					where: {
						fundWalletId: fundWallet.id,
						targetWalletId,
						status: FundDistributionStatus.Pending,
						priority: FundDistributionPriority.Critical,
					},
					select: { id: true, amount: true },
				});
				if (!request) return;

				await processRequestsForFundWallet(fundWallet, [
					{ id: request.id, targetWalletId, targetAddress: targetWallet.walletAddress, amount: request.amount },
				]);
			});
		}
	}

	async processDistributionCycle(): Promise<void> {
		await withJobLock(mutex, 'fund_distribution_cycle', async () => {
			// Phase A: Scan for Low-status wallets with no pending/submitted distribution request
			await this.scanAndCreateMissingRequests();

			// Phase B: Process critical pending requests immediately
			await this.processCriticalRequests();

			// Phase C: Process warning requests whose batch window has expired
			await this.processExpiredBatchRequests();

			// Phase D: Confirm submitted transactions
			await this.confirmSubmittedRequests();
		});
	}

	private async scanAndCreateMissingRequests(): Promise<void> {
		// Find all wallets with Low balance rules that have no pending/submitted distribution request
		const lowBalanceWallets = await prisma.hotWallet.findMany({
			where: {
				deletedAt: null,
				type: { not: HotWalletType.Funding },
				LowBalanceRules: {
					some: {
						status: LowBalanceStatus.Low,
						enabled: true,
						assetUnit: 'lovelace',
					},
				},
				FundDistributionsReceived: {
					none: {
						status: { in: [FundDistributionStatus.Pending, FundDistributionStatus.Submitted] },
					},
				},
			},
			select: {
				id: true,
				paymentSourceId: true,
				LowBalanceRules: {
					where: { status: LowBalanceStatus.Low, enabled: true, assetUnit: 'lovelace' },
					select: { lastKnownAmount: true },
				},
			},
		});

		for (const wallet of lowBalanceWallets) {
			// Use lastKnownAmount for priority classification. If null (rule never evaluated),
			// default to 0n so the request is treated as Critical — the safe assumption
			// when we have no balance data.
			const lastKnownAmount = wallet.LowBalanceRules[0]?.lastKnownAmount ?? 0n;
			await this.requestTopup({
				targetWalletId: wallet.id,
				currentBalance: lastKnownAmount,
				paymentSourceId: wallet.paymentSourceId,
			});
		}
	}

	private async processCriticalRequests(): Promise<void> {
		const criticalRequests = await prisma.fundDistributionRequest.findMany({
			where: {
				priority: FundDistributionPriority.Critical,
				status: FundDistributionStatus.Pending,
			},
			select: {
				id: true,
				fundWalletId: true,
				targetWalletId: true,
				amount: true,
				TargetWallet: { select: { walletAddress: true } },
			},
			orderBy: { createdAt: 'asc' },
		});

		if (criticalRequests.length === 0) return;

		// Group by fund wallet
		const byFundWallet = new Map<string, typeof criticalRequests>();
		for (const req of criticalRequests) {
			const group = byFundWallet.get(req.fundWalletId) ?? [];
			group.push(req);
			byFundWallet.set(req.fundWalletId, group);
		}

		for (const [fundWalletId, requests] of byFundWallet) {
			const fundWallet = await this.loadFundWalletContext(fundWalletId);
			if (!fundWallet) continue;

			const mappedRequests = requests.map((r) => ({
				id: r.id,
				targetWalletId: r.targetWalletId,
				targetAddress: r.TargetWallet.walletAddress,
				amount: r.amount,
			}));

			await processRequestsForFundWallet(fundWallet, mappedRequests);
		}
	}

	private async processExpiredBatchRequests(): Promise<void> {
		// Find pending warning requests grouped by fund wallet
		const warningRequests = await prisma.fundDistributionRequest.findMany({
			where: {
				priority: FundDistributionPriority.Warning,
				status: FundDistributionStatus.Pending,
			},
			select: {
				id: true,
				fundWalletId: true,
				targetWalletId: true,
				amount: true,
				createdAt: true,
				TargetWallet: { select: { walletAddress: true } },
				FundWallet: {
					select: {
						FundDistributionConfig: { select: { batchWindowMs: true } },
					},
				},
			},
			orderBy: { createdAt: 'asc' },
		});

		if (warningRequests.length === 0) return;

		// Group by fund wallet, check if oldest request exceeds batch window
		const byFundWallet = new Map<string, typeof warningRequests>();
		for (const req of warningRequests) {
			const group = byFundWallet.get(req.fundWalletId) ?? [];
			group.push(req);
			byFundWallet.set(req.fundWalletId, group);
		}

		const now = Date.now();
		for (const [fundWalletId, requests] of byFundWallet) {
			const batchWindowMs =
				requests[0]?.FundWallet.FundDistributionConfig?.batchWindowMs ??
				CONSTANTS.FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS;
			const oldestCreatedAt = requests[0]?.createdAt.getTime() ?? now;

			if (now - oldestCreatedAt < batchWindowMs) continue;

			const fundWallet = await this.loadFundWalletContext(fundWalletId);
			if (!fundWallet) continue;

			await processRequestsForFundWallet(
				fundWallet,
				requests.map((r) => ({
					id: r.id,
					targetWalletId: r.targetWalletId,
					targetAddress: r.TargetWallet.walletAddress,
					amount: r.amount,
				})),
			);
		}
	}

	private async confirmSubmittedRequests(): Promise<void> {
		// Only confirm requests submitted more than 5 minutes ago.
		// Transactions submitted in the current cycle will not be indexed by Blockfrost yet —
		// confirming them immediately would incorrectly mark them as Failed.
		const confirmableAfter = new Date(Date.now() - 300_000);

		const submittedRequests = await prisma.fundDistributionRequest.findMany({
			where: {
				status: FundDistributionStatus.Submitted,
				txHash: { not: null },
				updatedAt: { lt: confirmableAfter },
			},
			select: {
				id: true,
				txHash: true,
				updatedAt: true,
				fundWalletId: true,
				FundWallet: {
					select: {
						id: true,
						lockedAt: true,
						pendingTransactionId: true,
						PaymentSource: {
							select: {
								PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
								network: true,
							},
						},
					},
				},
			},
		});

		// Group by fund wallet so we only unlock once per wallet after all its submitted requests are processed
		const byFundWallet = new Map<string, typeof submittedRequests>();
		for (const req of submittedRequests) {
			const group = byFundWallet.get(req.fundWalletId) ?? [];
			group.push(req);
			byFundWallet.set(req.fundWalletId, group);
		}

		for (const [fundWalletId, requests] of byFundWallet) {
			const rpcKey = requests[0]?.FundWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!rpcKey) continue;

			const { createMeshProvider } = await import('@/services/shared/provider-factory');
			const provider = createMeshProvider(rpcKey);

			// Deduplicate by txHash — batched requests share one hash, so one Blockfrost call covers all
			const byTxHash = new Map<string, typeof requests>();
			for (const req of requests) {
				if (!req.txHash) continue;
				const group = byTxHash.get(req.txHash) ?? [];
				group.push(req);
				byTxHash.set(req.txHash, group);
			}

			// Track whether any tx is still pending indexing — if so, keep the wallet locked
			let hasUnresolved = false;

			for (const [txHash, txRequests] of byTxHash) {
				try {
					const txInfo = await provider.fetchTxInfo(txHash);

					if (txInfo) {
						await prisma.fundDistributionRequest.updateMany({
							where: { id: { in: txRequests.map((r) => r.id) } },
							data: { status: FundDistributionStatus.Confirmed, error: null },
						});
					} else {
						// Only mark as Failed after the confirmation timeout has elapsed.
						// Within the window the requests stay Submitted and will be retried next cycle
						// (Blockfrost indexing can lag, especially on mainnet).
						const submittedAt = txRequests[0]?.updatedAt.getTime() ?? 0;
						const timedOut = Date.now() - submittedAt > CONSTANTS.FUND_DISTRIBUTION_TX_CONFIRMATION_TIMEOUT_MS;

						if (timedOut) {
							await prisma.fundDistributionRequest.updateMany({
								where: { id: { in: txRequests.map((r) => r.id) } },
								data: {
									status: FundDistributionStatus.Failed,
									error: 'Transaction not found on-chain after timeout',
								},
							});
						} else {
							logger.debug('Fund distribution tx not yet indexed, will retry next cycle', {
								component: 'fund_distribution',
								tx_hash: txHash,
							});
							hasUnresolved = true;
						}
					}
				} catch (error) {
					logger.warn('Failed to confirm fund distribution tx', {
						component: 'fund_distribution',
						tx_hash: txHash,
						request_ids: txRequests.map((r) => r.id),
						error: interpretBlockchainError(error),
					});
					hasUnresolved = true;
				}
			}

			// Only unlock the fund wallet when all submitted txes have reached a terminal state.
			// If any tx is still pending indexing, keep the lock to prevent duplicate distributions.
			if (!hasUnresolved) {
				await prisma.hotWallet.update({
					where: { id: fundWalletId },
					data: {
						lockedAt: null,
						PendingTransaction: { disconnect: true },
					},
				});

				logger.info('Fund wallet unlocked after distribution confirmation', {
					component: 'fund_distribution',
					fund_wallet_id: fundWalletId,
				});
			} else {
				logger.debug('Fund wallet kept locked — unresolved txes still pending confirmation', {
					component: 'fund_distribution',
					fund_wallet_id: fundWalletId,
				});
			}
		}
	}

	private async loadFundWalletContext(fundWalletId: string): Promise<FundWalletContext | null> {
		const wallet = await prisma.hotWallet.findFirst({
			where: { id: fundWalletId, deletedAt: null },
			select: {
				id: true,
				walletAddress: true,
				walletVkey: true,
				paymentSourceId: true,
				LowBalanceRules: {
					where: { assetUnit: 'lovelace', enabled: true },
					select: { id: true },
					take: 1,
				},
				Secret: { select: { encryptedMnemonic: true } },
				PaymentSource: {
					select: {
						network: true,
						PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
					},
				},
				FundDistributionConfig: {
					select: {
						enabled: true,
						warningThreshold: true,
						criticalThreshold: true,
						topupAmount: true,
						batchWindowMs: true,
					},
				},
			},
		});

		if (
			!wallet?.Secret ||
			!wallet.FundDistributionConfig?.enabled ||
			!wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey
		) {
			return null;
		}

		return {
			id: wallet.id,
			walletAddress: wallet.walletAddress,
			walletVkey: wallet.walletVkey,
			lowBalanceRuleId: wallet.LowBalanceRules[0]?.id ?? '',
			paymentSourceId: wallet.paymentSourceId,
			network: wallet.PaymentSource.network,
			rpcProviderApiKey: wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
			encryptedMnemonic: wallet.Secret.encryptedMnemonic,
			config: {
				warningThreshold: wallet.FundDistributionConfig.warningThreshold,
				criticalThreshold: wallet.FundDistributionConfig.criticalThreshold,
				topupAmount: wallet.FundDistributionConfig.topupAmount,
				batchWindowMs: wallet.FundDistributionConfig.batchWindowMs,
			},
		};
	}
}

export const fundDistributionService = new FundDistributionService();
