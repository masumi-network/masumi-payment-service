import { logger } from '@/utils/logger';
import { CONFIG } from '@/utils/config';
import { checkLatestTransactions } from '@/services/cardano-tx-handler/';
import { batchLatestPaymentEntriesV1 } from '@/services/cardano-payment-batcher/cardano-payment-batcher.service';
import { collectOutstandingPaymentsV1 } from '@/services/cardano-collection-handler/';
import { collectRefundV1 } from '@/services/cardano-refund-handler/';
import { updateWalletTransactionHash } from '@/services/update-wallet-transaction-hash-handler/';
import { requestRefundsV1 } from '@/services/cardano-request-refund-handler/';
import { AsyncInterval } from '@/utils/async-interval';
import { cancelRefundsV1 } from '@/services/cardano-cancel-refund-handler/';
import { registerAgentV1 } from '@/services/cardano-register-handler/';
import { deRegisterAgentV1 } from '@/services/cardano-deregister-handler/';
import { submitResultV1 } from '@/services/cardano-submit-result-handler/';
import { authorizeRefundV1 } from '@/services/cardano-authorize-refund-handler/';
import { handleAutomaticDecisions } from '@/services/automatic-decision-handler';
import { checkRegistryTransactions } from '@/services/cardano-registry-tx-sync-handler/cardano-registry-tx-sync-handler.service';
import { webhookQueueService } from '@/services/webhook-handler/webhook-queue.service';
import { walletLowBalanceMonitorService } from '@/services/wallet-low-balance-monitor';

type ScheduledJob = {
	initialDelayMs: number;
	intervalMs: number;
	startMessage: string;
	run: () => Promise<void>;
	finishMessage?: string;
};

const startupTimers = new Set<NodeJS.Timeout>();
const activeJobStops = new Set<() => Promise<void>>();
let jobsInitialized = false;

async function runScheduledJob(job: ScheduledJob) {
	logger.info(job.startMessage);
	const start = Date.now();
	await job.run();
	if (job.finishMessage) {
		logger.info(job.finishMessage + ' in ' + (Date.now() - start) / 1000 + 's');
	}
}

function scheduleJob(job: ScheduledJob) {
	if (!jobsInitialized) {
		return;
	}

	const timer = setTimeout(() => {
		startupTimers.delete(timer);
		if (!jobsInitialized) {
			return;
		}

		const stop = AsyncInterval.start(async () => runScheduledJob(job), job.intervalMs);
		activeJobStops.add(stop);
	}, job.initialDelayMs);

	startupTimers.add(timer);
}

export async function initJobs() {
	if (jobsInitialized) {
		logger.warn('Async intervals are already initialized');
		return;
	}

	jobsInitialized = true;

	const start = new Date();
	await new Promise((resolve) => setTimeout(resolve, 500));
	await checkLatestTransactions();
	await checkRegistryTransactions();
	logger.info('Checked and synced transactions in ' + (new Date().getTime() - start.getTime()) / 1000 + 's');

	if (!jobsInitialized) {
		return;
	}

	const jobs: ScheduledJob[] = [
		{
			initialDelayMs: 750,
			intervalMs: CONFIG.BATCH_PAYMENT_INTERVAL * 1000,
			startMessage: 'Starting to check for batched payments',
			finishMessage: 'Finished to check for batched payments',
			run: batchLatestPaymentEntriesV1,
		},
		{
			initialDelayMs: 1000,
			intervalMs: CONFIG.CHECK_REGISTRY_TRANSACTIONS_INTERVAL * 1000,
			startMessage: 'Starting to check for registry transactions',
			run: checkRegistryTransactions,
		},
		{
			initialDelayMs: 5000,
			intervalMs: CONFIG.CHECK_COLLECTION_INTERVAL * 1000,
			startMessage: 'Starting to check for outstanding payments',
			finishMessage: 'Finished to check for outstanding payments',
			run: collectOutstandingPaymentsV1,
		},
		{
			initialDelayMs: 10000,
			intervalMs: CONFIG.CHECK_COLLECT_REFUND_INTERVAL * 1000,
			startMessage: 'Starting to check for refunds',
			finishMessage: 'Finished to check for refunds',
			run: collectRefundV1,
		},
		{
			initialDelayMs: 15000,
			intervalMs: CONFIG.CHECK_SET_REFUND_INTERVAL * 1000,
			startMessage: 'Starting to check for timed out refunds',
			finishMessage: 'Finished to check for timed out refunds',
			run: requestRefundsV1,
		},
		{
			initialDelayMs: 20000,
			intervalMs: CONFIG.CHECK_UNSET_REFUND_INTERVAL * 1000,
			startMessage: 'Starting to check for timed out refunds',
			finishMessage: 'Finished to check for timed out refunds',
			run: cancelRefundsV1,
		},
		{
			initialDelayMs: 23000,
			intervalMs: CONFIG.CHECK_AUTHORIZE_REFUND_INTERVAL * 1000,
			startMessage: 'Starting to check to authorize refunds',
			finishMessage: 'Finished to check to authorize refunds',
			run: authorizeRefundV1,
		},
		{
			initialDelayMs: 25000,
			intervalMs: CONFIG.REGISTER_AGENT_INTERVAL * 1000,
			startMessage: 'Starting to check for agent registration',
			finishMessage: 'Finished to check for agent registration',
			run: registerAgentV1,
		},
		{
			initialDelayMs: 30000,
			intervalMs: CONFIG.DEREGISTER_AGENT_INTERVAL * 1000,
			startMessage: 'Starting to check for agent deregistration',
			finishMessage: 'Finished to check for agent deregistration',
			run: deRegisterAgentV1,
		},
		{
			initialDelayMs: 35000,
			intervalMs: CONFIG.CHECK_WALLET_TRANSACTION_HASH_INTERVAL * 1000,
			startMessage: 'Starting to check for wallet transactions and wallets to unlock',
			finishMessage: 'Finished to check for wallet transactions and wallets to unlock',
			run: updateWalletTransactionHash,
		},
		{
			initialDelayMs: 40000,
			intervalMs: CONFIG.CHECK_TX_INTERVAL * 1000,
			startMessage: 'Starting to sync cardano payment entries',
			finishMessage: 'Finished to sync cardano payment entries',
			run: checkLatestTransactions,
		},
		{
			initialDelayMs: 45000,
			intervalMs: CONFIG.CHECK_SUBMIT_RESULT_INTERVAL * 1000,
			startMessage: 'Starting to check for submit result',
			finishMessage: 'Finished to check for submit result',
			run: submitResultV1,
		},
		{
			initialDelayMs: 7500,
			intervalMs: CONFIG.AUTO_DECISION_INTERVAL * 1000,
			startMessage: 'Starting automatic decision handler',
			finishMessage: 'Finished automatic decision handler',
			run: handleAutomaticDecisions,
		},
		{
			initialDelayMs: 2000,
			intervalMs: CONFIG.WEBHOOK_DELIVERY_INTERVAL * 1000,
			startMessage: 'Starting webhook delivery processor',
			finishMessage: 'Finished webhook delivery processor',
			run: () => webhookQueueService.processPendingDeliveries(),
		},
		{
			initialDelayMs: 2500,
			intervalMs: CONFIG.LOW_BALANCE_CHECK_INTERVAL * 1000,
			startMessage: 'Starting low balance monitoring',
			finishMessage: 'Finished low balance monitoring',
			run: () => walletLowBalanceMonitorService.runScheduledMonitoringCycle(),
		},
		{
			initialDelayMs: 50000,
			intervalMs: 24 * 60 * 60 * 1000,
			startMessage: 'Starting webhook cleanup',
			finishMessage: 'Finished webhook cleanup',
			run: () => webhookQueueService.cleanupOldDeliveries(),
		},
	];

	jobs.forEach(scheduleJob);

	await new Promise((resolve) => setTimeout(resolve, 200));
	logger.info('Initialized async intervals');
}

export async function stopJobs() {
	jobsInitialized = false;

	for (const timer of startupTimers) {
		clearTimeout(timer);
	}
	startupTimers.clear();

	const jobStops = Array.from(activeJobStops);
	activeJobStops.clear();
	await Promise.allSettled(jobStops.map((stop) => stop()));

	logger.info('Stopped async intervals');
}
