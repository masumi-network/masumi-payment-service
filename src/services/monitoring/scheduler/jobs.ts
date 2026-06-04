import { CONFIG } from '@masumi/payment-core/config';
import { syncSimpleApiListings } from '@/services/simple-api-sync';
import { web3CardanoV1, web3CardanoV2 } from '@/services/payment-source-types';
import {
	checkLatestTransactions,
	cleanupOrphanActionData,
	reconcileAmbiguousFundingV2,
	updateWalletTransactionHash,
} from '@/services/transactions';
import { walletLowBalanceMonitorService } from '@/services/wallets';
import { webhookQueueService } from '@/services/webhooks';
import type { JobDefinition } from '@/services/shared';

export const scheduledJobs: JobDefinition[] = [
	{
		initialDelayMs: 750,
		intervalMs: CONFIG.BATCH_PAYMENT_INTERVAL * 1000,
		startMessage: 'Starting to check for batched payments',
		finishMessage: 'Finished to check for batched payments',
		run: web3CardanoV1.batchLatestPaymentEntries,
	},
	{
		initialDelayMs: 1000,
		intervalMs: CONFIG.CHECK_REGISTRY_TRANSACTIONS_INTERVAL * 1000,
		startMessage: 'Starting to check for registry transactions',
		run: web3CardanoV1.checkRegistryTransactions,
	},
	{
		initialDelayMs: 1500,
		intervalMs: CONFIG.CHECK_REGISTRY_TRANSACTIONS_INTERVAL * 1000,
		startMessage: 'Starting to check for inbox registry transactions',
		run: web3CardanoV1.checkInboxAgentRegistrationTransactions,
	},
	{
		initialDelayMs: 5000,
		intervalMs: CONFIG.CHECK_COLLECTION_INTERVAL * 1000,
		startMessage: 'Starting to check for outstanding payments',
		finishMessage: 'Finished to check for outstanding payments',
		run: web3CardanoV1.collectOutstandingPayments,
	},
	{
		initialDelayMs: 10000,
		intervalMs: CONFIG.CHECK_COLLECT_REFUND_INTERVAL * 1000,
		startMessage: 'Starting to check for refunds',
		finishMessage: 'Finished to check for refunds',
		run: web3CardanoV1.collectRefund,
	},
	{
		initialDelayMs: 15000,
		intervalMs: CONFIG.CHECK_SET_REFUND_INTERVAL * 1000,
		startMessage: 'Starting to check for timed out refunds',
		finishMessage: 'Finished to check for timed out refunds',
		run: web3CardanoV1.requestRefunds,
	},
	{
		initialDelayMs: 20000,
		intervalMs: CONFIG.CHECK_UNSET_REFUND_INTERVAL * 1000,
		startMessage: 'Starting to check for timed out refunds',
		finishMessage: 'Finished to check for timed out refunds',
		run: web3CardanoV1.cancelRefunds,
	},
	{
		initialDelayMs: 21000,
		intervalMs: CONFIG.CHECK_AUTHORIZE_WITHDRAWAL_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 withdrawal authorizations',
		finishMessage: 'Finished to check for V2 withdrawal authorizations',
		run: web3CardanoV2.authorizeWithdrawals,
	},
	{
		initialDelayMs: 23000,
		intervalMs: CONFIG.CHECK_AUTHORIZE_REFUND_INTERVAL * 1000,
		startMessage: 'Starting to check to authorize refunds',
		finishMessage: 'Finished to check to authorize refunds',
		run: web3CardanoV1.authorizeRefund,
	},
	{
		initialDelayMs: 25000,
		intervalMs: CONFIG.REGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for agent registration',
		finishMessage: 'Finished to check for agent registration',
		run: web3CardanoV1.registerAgent,
	},
	{
		initialDelayMs: 26000,
		intervalMs: CONFIG.REGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 agent registration',
		finishMessage: 'Finished to check for V2 agent registration',
		run: web3CardanoV2.registerAgent,
	},
	{
		initialDelayMs: 27500,
		intervalMs: CONFIG.REGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for inbox agent registration',
		finishMessage: 'Finished to check for inbox agent registration',
		run: web3CardanoV1.registerInboxAgent,
	},
	{
		initialDelayMs: 30000,
		intervalMs: CONFIG.DEREGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for agent deregistration',
		finishMessage: 'Finished to check for agent deregistration',
		run: web3CardanoV1.deRegisterAgent,
	},
	{
		initialDelayMs: 31000,
		intervalMs: CONFIG.DEREGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 agent deregistration',
		finishMessage: 'Finished to check for V2 agent deregistration',
		run: web3CardanoV2.deRegisterAgent,
	},
	{
		initialDelayMs: 32500,
		intervalMs: CONFIG.DEREGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for inbox agent deregistration',
		finishMessage: 'Finished to check for inbox agent deregistration',
		run: web3CardanoV1.deRegisterInboxAgent,
	},
	{
		initialDelayMs: 35000,
		intervalMs: CONFIG.CHECK_WALLET_TRANSACTION_HASH_INTERVAL * 1000,
		startMessage: 'Starting to check for wallet transactions and wallets to unlock',
		finishMessage: 'Finished to check for wallet transactions and wallets to unlock',
		run: updateWalletTransactionHash,
	},
	{
		// V2 funding-tx reconciliation: resolves Pending shared Transactions
		// whose submit outcome was ambiguous (network/transport throw, late
		// gateway response). Promotes intendedTxHash → txHash on chain hit
		// OR reverts batched PurchaseRequests + frees the wallet after the
		// invalidHereafterSlot TTL has provably elapsed. Closes the funding
		// double-lock window — see docs/adr (TBD) and the design in
		// `src/services/transactions/funding-reconciliation/index.ts`.
		// Same cadence as wallet-timeouts so an ambiguous row gets at most
		// ~CHECK_WALLET_TRANSACTION_HASH_INTERVAL of stuck time.
		initialDelayMs: 37500,
		intervalMs: CONFIG.CHECK_WALLET_TRANSACTION_HASH_INTERVAL * 1000,
		startMessage: 'Starting V2 funding-tx reconciliation',
		finishMessage: 'Finished V2 funding-tx reconciliation',
		run: reconcileAmbiguousFundingV2,
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
		run: web3CardanoV1.submitResult,
	},
	{
		initialDelayMs: 7500,
		intervalMs: CONFIG.AUTO_DECISION_INTERVAL * 1000,
		startMessage: 'Starting automatic decision handler',
		finishMessage: 'Finished automatic decision handler',
		run: web3CardanoV1.handleAutomaticDecisions,
	},
	{
		initialDelayMs: 8500,
		intervalMs: CONFIG.AUTO_DECISION_INTERVAL * 1000,
		startMessage: 'Starting V2 automatic decision handler',
		finishMessage: 'Finished V2 automatic decision handler',
		run: web3CardanoV2.handleAutomaticDecisions,
	},
	{
		initialDelayMs: 1100,
		intervalMs: CONFIG.BATCH_PAYMENT_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 batched payments',
		finishMessage: 'Finished to check for V2 batched payments',
		run: web3CardanoV2.batchLatestPaymentEntries,
	},
	{
		initialDelayMs: 1300,
		intervalMs: CONFIG.CHECK_REGISTRY_TRANSACTIONS_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 registry transactions',
		run: web3CardanoV2.checkRegistryTransactions,
	},
	{
		initialDelayMs: 1800,
		intervalMs: CONFIG.CHECK_REGISTRY_TRANSACTIONS_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 inbox registry transactions',
		run: web3CardanoV2.checkInboxAgentRegistrationTransactions,
	},
	{
		initialDelayMs: 5500,
		intervalMs: CONFIG.CHECK_COLLECTION_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 outstanding payments',
		finishMessage: 'Finished to check for V2 outstanding payments',
		run: web3CardanoV2.collectOutstandingPayments,
	},
	{
		initialDelayMs: 10500,
		intervalMs: CONFIG.CHECK_COLLECT_REFUND_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 refunds',
		finishMessage: 'Finished to check for V2 refunds',
		run: web3CardanoV2.collectRefund,
	},
	{
		initialDelayMs: 15500,
		intervalMs: CONFIG.CHECK_SET_REFUND_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 timed out refunds',
		finishMessage: 'Finished to check for V2 timed out refunds',
		run: web3CardanoV2.requestRefunds,
	},
	{
		initialDelayMs: 23500,
		intervalMs: CONFIG.CHECK_AUTHORIZE_REFUND_INTERVAL * 1000,
		startMessage: 'Starting to check to authorize V2 refunds',
		finishMessage: 'Finished to check to authorize V2 refunds',
		run: web3CardanoV2.authorizeRefund,
	},
	{
		initialDelayMs: 27800,
		intervalMs: CONFIG.REGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 inbox agent registration',
		finishMessage: 'Finished to check for V2 inbox agent registration',
		run: web3CardanoV2.registerInboxAgent,
	},
	{
		initialDelayMs: 32800,
		intervalMs: CONFIG.DEREGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 inbox agent deregistration',
		finishMessage: 'Finished to check for V2 inbox agent deregistration',
		run: web3CardanoV2.deRegisterInboxAgent,
	},
	{
		// V2 registry UpdateAction tick. Updates re-use the
		// REGISTER_AGENT_INTERVAL cadence — they are register-like in
		// flow (burn + mint in one tx) and frequency on a given wallet
		// is bounded by chain confirmation time anyway. Offset by
		// 33500ms so the staggered startup keeps each tick on its own
		// scheduler slot.
		initialDelayMs: 33500,
		intervalMs: CONFIG.REGISTER_AGENT_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 agent update',
		finishMessage: 'Finished to check for V2 agent update',
		run: web3CardanoV2.updateAgent,
	},
	{
		initialDelayMs: 45500,
		intervalMs: CONFIG.CHECK_SUBMIT_RESULT_INTERVAL * 1000,
		startMessage: 'Starting to check for V2 submit result',
		finishMessage: 'Finished to check for V2 submit result',
		run: web3CardanoV2.submitResult,
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
		intervalMs: CONFIG.WEBHOOK_CLEANUP_INTERVAL * 1000,
		startMessage: 'Starting webhook cleanup',
		finishMessage: 'Finished webhook cleanup',
		run: () => webhookQueueService.cleanupOldDeliveries(),
	},
	{
		// Daily-ish prune of PaymentActionData / PurchaseActionData rows
		// that were orphaned by the V2 rollback drift-check's "leak the
		// row, do not corrupt history" rule. Long initial delay so
		// startup-burst load is not impacted; recurrence governed by
		// ORPHAN_ACTION_CLEANUP_INTERVAL_SECONDS env (default 24h).
		initialDelayMs: 60000,
		intervalMs: CONFIG.ORPHAN_ACTION_CLEANUP_INTERVAL_SECONDS * 1000,
		startMessage: 'Starting orphan action-data cleanup',
		finishMessage: 'Finished orphan action-data cleanup',
		run: cleanupOrphanActionData,
	},
	{
		initialDelayMs: 55000,
		intervalMs: CONFIG.SIMPLE_API_SYNC_INTERVAL * 1000,
		startMessage: 'Starting SimpleApi registry sync',
		finishMessage: 'Finished SimpleApi registry sync',
		run: syncSimpleApiListings,
	},
];
