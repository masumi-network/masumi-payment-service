import { logger } from '@/utils/logger';
import { CONFIG } from '@/utils/config';
import { checkLatestTransactions } from '@/services/cardano-tx-handler/';
import { batchLatestPaymentEntriesV1 } from '@/services/cardano-payment-batcher/cardano-payment-batcher.service';
import { collectOutstandingPaymentsV1 } from '@/services/cardano-collection-handler/';
import { collectRefundV1 } from '@/services/cardano-refund-handler/';
import { updateWalletTransactionHash } from '@/services/update-wallet-transaction-hash-handler/';
import { requestRefundsV1 } from '../cardano-request-refund-handler/';
import { AsyncInterval } from '@/utils/async-interval';
import { cancelRefundsV1 } from '@/services/cardano-cancel-refund-handler/';
import { registerAgentV1 } from '@/services/cardano-register-handler/';
import { deRegisterAgentV1 } from '@/services/cardano-deregister-handler/';
import { submitResultV1 } from '@/services/cardano-submit-result-handler/';
import { authorizeRefundV1 } from '@/services/cardano-authorize-refund-handler/';
import { handleAutomaticDecisions } from '@/services/automatic-decision-handler';
import { checkRegistryTransactions } from '@/services/cardano-registry-tx-sync-handler/cardano-registry-tx-sync-handler.service';

export async function initJobs() {
  const start = new Date();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await checkLatestTransactions();
  await checkRegistryTransactions();
  logger.info(
    'Checked and synced transactions in ' +
      (new Date().getTime() - start.getTime()) / 1000 +
      's',
  );

  void new Promise((resolve) => setTimeout(resolve, 750)).then(() => {
    // Batch payments interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for batched payments');
      const start = new Date();
      await batchLatestPaymentEntriesV1();
      logger.info(
        'Finished to check for batched payments in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.BATCH_PAYMENT_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 1000)).then(() => {
    // Check registry transactions interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for registry transactions');
      await checkRegistryTransactions();
    }, CONFIG.CHECK_REGISTRY_TRANSACTIONS_INTERVAL * 1000); // Convert seconds to milliseconds
  });
  void new Promise((resolve) => setTimeout(resolve, 5000)).then(() => {
    // Check collections interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for outstanding payments');
      const start = new Date();
      await collectOutstandingPaymentsV1();
      logger.info(
        'Finished to check for outstanding payments in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_COLLECTION_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 10000)).then(() => {
    // Check collection and refund interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for refunds');
      const start = new Date();
      await collectRefundV1();
      logger.info(
        'Finished to check for refunds in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_COLLECT_REFUND_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 15000)).then(() => {
    // Check refund interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for timed out refunds');
      const start = new Date();
      await requestRefundsV1();
      logger.info(
        'Finished to check for timed out refunds in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_SET_REFUND_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 20000)).then(() => {
    // Check unset refund interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for timed out refunds');
      const start = new Date();
      await cancelRefundsV1();
      logger.info(
        'Finished to check for timed out refunds in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_UNSET_REFUND_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 23000)).then(() => {
    // Check unset refund interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check to authorize refunds');
      const start = new Date();
      await authorizeRefundV1();
      logger.info(
        'Finished to check to authorize refunds in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_AUTHORIZE_REFUND_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 25000)).then(() => {
    // Check unset refund interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for agent registration');
      const start = new Date();
      await registerAgentV1();
      logger.info(
        'Finished to check for agent registration in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.REGISTER_AGENT_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 30000)).then(() => {
    // Check unset refund interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for agent deregistration');
      const start = new Date();
      await deRegisterAgentV1();
      logger.info(
        'Finished to check for agent deregistration in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.DEREGISTER_AGENT_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 35000)).then(() => {
    // Check wallet transaction hash interval
    AsyncInterval.start(async () => {
      logger.info(
        'Starting to check for wallet transactions and wallets to unlock',
      );
      const start = new Date();
      await updateWalletTransactionHash();
      logger.info(
        'Finished to check for wallet transactions and wallets to unlock in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_WALLET_TRANSACTION_HASH_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 40000)).then(() => {
    // Check transactions interval
    AsyncInterval.start(async () => {
      logger.info('Starting to sync cardano payment entries');
      const start = new Date();
      await checkLatestTransactions();
      logger.info(
        'Finished to sync cardano payment entries in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_TX_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 45000)).then(() => {
    // Check submit result interval
    AsyncInterval.start(async () => {
      logger.info('Starting to check for submit result');
      const start = new Date();
      await submitResultV1();
      logger.info(
        'Finished to check for submit result in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.CHECK_SUBMIT_RESULT_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  void new Promise((resolve) => setTimeout(resolve, 7500)).then(() => {
    // Automatic decision handler interval
    AsyncInterval.start(async () => {
      logger.info('Starting automatic decision handler');
      const start = new Date();
      await handleAutomaticDecisions();
      logger.info(
        'Finished automatic decision handler in ' +
          (new Date().getTime() - start.getTime()) / 1000 +
          's',
      );
    }, CONFIG.AUTO_DECISION_INTERVAL * 1000); // Convert seconds to milliseconds
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  logger.info('Initialized async intervals');
}
