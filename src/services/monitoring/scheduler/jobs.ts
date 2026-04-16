import { CONFIG } from '@/utils/config';
import {
	handleAutomaticDecisions,
	collectOutstandingPaymentsV1,
	submitResultV1,
	authorizeRefundV1,
} from '@/services/payments';
import { batchLatestPaymentEntriesV1, collectRefundV1, requestRefundsV1, cancelRefundsV1 } from '@/services/purchases';
import { registerAgentV1, deRegisterAgentV1, checkRegistryTransactions } from '@/services/registry';
import {
	checkInboxAgentRegistrationTransactions,
	deRegisterInboxAgentV1,
	registerInboxAgentV1,
} from '@/services/registry-inbox';
import { checkLatestTransactions, updateWalletTransactionHash } from '@/services/transactions';
import { walletLowBalanceMonitorService, fundDistributionService } from '@/services/wallets';
import { webhookQueueService } from '@/services/webhooks';
import type { JobDefinition } from '@/services/shared';

export const scheduledJobs: JobDefinition[] = [
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
		initialDelayMs: 1500,
		intervalMs: CONFIG.CHECK_REGISTRY_TRANSACTIONS_INTERVAL * 1000,
		startMessage: 'Starting to check for inbox registry transactions',
		run: checkInboxAgentRegistrationTransactions,
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
		initialDelayMs: 27500,
		intervalMs: CONFIG.REGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for inbox agent registration',
		finishMessage: 'Finished to check for inbox agent registration',
		run: registerInboxAgentV1,
	},
	{
		initialDelayMs: 30000,
		intervalMs: CONFIG.DEREGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for agent deregistration',
		finishMessage: 'Finished to check for agent deregistration',
		run: deRegisterAgentV1,
	},
	{
		initialDelayMs: 32500,
		intervalMs: CONFIG.DEREGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for inbox agent deregistration',
		finishMessage: 'Finished to check for inbox agent deregistration',
		run: deRegisterInboxAgentV1,
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
		initialDelayMs: 55000,
		intervalMs: 30 * 1000,
		startMessage: 'Starting fund distribution processing',
		finishMessage: 'Finished fund distribution processing',
		run: () => fundDistributionService.processDistributionCycle(),
	},
	{
		initialDelayMs: 50000,
		intervalMs: CONFIG.WEBHOOK_CLEANUP_INTERVAL * 1000,
		startMessage: 'Starting webhook cleanup',
		finishMessage: 'Finished webhook cleanup',
		run: () => webhookQueueService.cleanupOldDeliveries(),
	},
];
