import { OnChainState, PaymentAction, PaymentSourceType, TransactionLayer } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { createMeshProvider } from '@/services/shared';
import { getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { processWalletBatch } from './batch';
import { runSubmitResultL2Pass } from './l2';
import type { PaymentRequestWithRelations } from './types';
import { SUBMIT_RESULT_WINDOW_SLACK_MS } from './window';

// V2 submit-result sizing. Each leg evaluates the Aiken `SubmitResult` redeemer
// over the same script; per-input ex-units run ~mem 4M / steps 1.5B in practice,
// so 6 fits well under the protocol max-ex-units even with headroom. The cap
// also matches the V2 register batch size for operational consistency.
const SUBMIT_RESULT_BATCH_SIZE = 7;

const mutex = new Mutex();

function groupRequestsByWallet(requests: PaymentRequestWithRelations[]): Map<string, PaymentRequestWithRelations[]> {
	const byWallet = new Map<string, PaymentRequestWithRelations[]>();
	for (const request of requests) {
		if (request.SmartContractWallet == null) continue;
		const list = byWallet.get(request.SmartContractWallet.id) ?? [];
		list.push(request);
		byWallet.set(request.SmartContractWallet.id, list);
	}
	return byWallet;
}

/**
 * The head path on its own, so it can be run the moment a result is submitted.
 *
 * L1 work waits for a batch because the chain paces it; a result inside an open
 * head is a signature exchange that finishes in under a second, so the wait is
 * latency we add rather than latency imposed on us. Extracted rather than
 * running the whole cycle early, because pulling the L1 pass forward would
 * change batching behaviour nobody asked to change.
 *
 * Shares the cycle's mutex: a request arriving mid-cycle is already covered by
 * the pass in flight, and two passes over the same rows would race for the same
 * wallet locks.
 */
export async function submitResultL2V2(): Promise<void> {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('submit_result_v2 is already running, skipping the on-demand L2 pass');
		return;
	}

	try {
		await runSubmitResultL2Pass();
	} catch (error) {
		logger.error('Error submitting V2 result on demand', { error });
	} finally {
		release?.();
	}
}

export async function submitResultV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('submit_result_v2 is already running, skipping cycle');
		return;
	}

	try {
		const nowMs = Date.now();
		const paymentContractsWithWalletLocked = await lockAndQueryPayments({
			paymentStatus: PaymentAction.SubmitResultRequested,
			requestedResultHash: { not: null },
			// vested_pay.ak `SubmitResult` accepts a tx in EITHER of two windows
			// (and only from FundsLocked / ResultSubmitted / RefundRequested /
			// Disputed — never WithdrawAuthorized / RefundAuthorized, which
			// determineNewContractState defers anyway):
			//
			//   A) Normal pre-deadline submit — tx ends before submit_result_time.
			//   B) Dispute-window result rotation — tx ends before
			//      external_dispute_unlock_time AND the current on-chain datum
			//      already carries a result (i.e. ResultSubmitted or Disputed).
			//
			// Each leg keeps ≥5min slack off its own boundary (default tx-window
			// invalidAfter is ~now+2.5min+buffer) so a submission never races the
			// ledger bound. resolveSubmitResultConstrainAfterMs picks the matching
			// upper bound per row at build time; this OR only gates eligibility.
			// (Previously only leg A was queried, so disputed rows past
			// submit_result_time were never selected and the contract's
			// dispute-rotation path was unreachable off-chain.)
			orFilters: [
				{
					submitResultTime: { gt: nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS },
					onChainState: {
						in: [
							OnChainState.FundsLocked,
							OnChainState.ResultSubmitted,
							OnChainState.RefundRequested,
							OnChainState.Disputed,
						],
					},
				},
				{
					submitResultTime: { lte: nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS },
					externalDisputeUnlockTime: { gt: nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS },
					onChainState: { in: [OnChainState.ResultSubmitted, OnChainState.Disputed] },
				},
			],
			maxBatchSize: SUBMIT_RESULT_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			// L1 only — Hydra L2 requests are handled by the dedicated single-item
			// head path below (processL2SubmitResult).
			layer: TransactionLayer.L1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length == 0) return;

				logger.info(
					`Submitting ${paymentContract.PaymentRequests.length} V2 results for payment source ${paymentContract.id}`,
				);

				const network = convertNetwork(paymentContract.network);
				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);
				const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);

				const grouped = groupRequestsByWallet(paymentContract.PaymentRequests);
				await Promise.allSettled(
					Array.from(grouped.values()).map(async (walletRequests) => {
						if (walletRequests.length === 0) return;
						await processWalletBatch(
							walletRequests,
							paymentContract,
							blockchainProvider,
							network,
							script,
							smartContractAddress,
						);
					}),
				);
			}),
		);

		await runSubmitResultL2Pass();
	} catch (error) {
		logger.error('Error submitting V2 result', { error });
	} finally {
		release?.();
	}
}
