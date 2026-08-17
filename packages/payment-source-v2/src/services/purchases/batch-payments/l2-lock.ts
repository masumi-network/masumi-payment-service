/**
 * V2 Hydra L2 funds-lock (head entry): which purchases run inside a head.
 *
 * ISOLATED from the L1 batch path on purpose. This half picks the requests
 * whose payment source is routed to L2, decides per request whether a usable
 * head exists, and defers or fails the ones that cannot run — the lock itself
 * lives in `./l2-lock-execute`.
 *
 * Requires a funded open head. In-head acceptance was validated on a Hydra
 * devnet with committed funds (see docs/hydra-l2-devnet-findings.md).
 */
import {
	HotWalletType,
	PaymentSourceType,
	PurchaseErrorType,
	PurchasingAction,
	TransactionLayer,
	Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { resolveUsableHydraHeadForPurchase } from '@/utils/hydra/resolve-hydra-head';
import { resolveEffectiveForceLayer } from '@/utils/logic/force-layer';
import { waitForFreeWallet } from '../../l2-pass';
import { isHotWalletEligibleForL2Lock } from './l2-lock-helpers';
import { executeL2Lock, type L2PurchaseRequest } from './l2-lock-execute';

/**
 * How long an auto-routed request waits for a busy head wallet before the L1
 * pass may take it.
 *
 * A head lock needs the wallet that is a participant in that head, and that
 * wallet builds one transaction at a time. Two purchases created seconds apart
 * therefore contend for it, and the second one used to lose the head entirely:
 * the L1 pass, running immediately after in the same tick, saw an unclaimed
 * request and put it on chain. Waiting a couple of ticks costs nothing and is
 * almost always enough, and the bound is what keeps a genuinely stuck wallet
 * from parking purchases indefinitely.
 */
const AUTO_L2_DEFER_WINDOW_MS = 2 * 60 * 1000;

export interface L2LockPassResult {
	/**
	 * Requests to keep away from L1 for this tick: a head is open for them, but
	 * its wallet was busy. They are not failed — the next pass retries them.
	 */
	deferredRequestIds: string[];
}

/**
 * Route FundsLockingRequested V2 purchase requests through an open Hydra head
 * when one exists for (buyer hot wallet, seller). Runs BEFORE the L1 batch pass;
 * a handled request gets an L2 CurrentTransaction, so the L1 lock-and-query
 * (which filters `CurrentTransaction: { is: null }`) naturally skips it — no
 * explicit exclusion needed.
 *
 * Invoked under the batch-payments per-tick mutex, so L2 selection is serialized
 * with the L1 pass within a process.
 */
export async function processL2PurchaseLocks(): Promise<L2LockPassResult> {
	// Requests this pass wanted to route into a head but could not, only because
	// the head's wallet was busy. Handed to the L1 pass so it leaves them alone
	// this tick.
	const deferredRequestIds: string[] = [];

	const paymentSources = await prisma.paymentSource.findMany({
		where: {
			deletedAt: null,
			syncInProgress: false,
			disablePaymentAt: null,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		},
		include: {
			PaymentSourceConfig: true,
			PurchaseRequests: {
				where: {
					NextAction: {
						requestedAction: PurchasingAction.FundsLockingRequested,
						errorType: null,
					},
					CurrentTransaction: { is: null },
					onChainState: null,
				},
				include: {
					PaidFunds: true,
					SellerWallet: true,
					NextAction: true,
					HotWalletLimit: { select: { id: true } },
				},
			},
			HotWallets: {
				where: {
					type: HotWalletType.Purchasing,
					deletedAt: null,
				},
				include: {
					Secret: true,
				},
			},
		},
	});

	for (const paymentContract of paymentSources) {
		if (paymentContract.PurchaseRequests.length === 0) {
			continue;
		}
		// Track wallets used this tick in addition to the durable DB lease. The set
		// avoids repeated probes against this query's now-stale wallet objects.
		const usedWalletIds = new Set<string>();
		/** Wallets this pass submitted with, whose confirmation it may wait on. */
		const awaitingConfirmation = new Set<string>();

		for (const request of paymentContract.PurchaseRequests) {
			// Resolve the buyer override against the seller choice authenticated by
			// the V2 identifier signature and persisted on this purchase. Payment and
			// purchase requests commonly live on different servers, so routing must
			// never depend on finding a local paired PaymentRequest.
			// This gates routing:
			//   L1        → never lock on L2 (leave for the L1 pass);
			//   L2        → REQUIRE an open head, else FAIL (never fall back to L1);
			//   conflict  → FAIL (buyer and seller forced different layers);
			//   null      → auto (try L2 if a head is available, else fall to L1).
			const effectiveForce = resolveEffectiveForceLayer(request.forceLayer, request.paymentForceLayer);
			if (effectiveForce === 'conflict') {
				await failForcedL2Request(request, 'forceLayer conflict: buyer and seller force different layers');
				continue;
			}
			if (effectiveForce === TransactionLayer.L1) {
				continue; // forced L1 → the L1 batch pass locks it
			}
			const forcedHydra = effectiveForce === TransactionLayer.L2;

			// `headAvailable` = a usable open head EXISTS for this buyer/seller pair,
			// independent of whether its wallet is still free THIS tick. It must be
			// probed for busy wallets too: otherwise, when more forced-Hydra purchases
			// than head-bearing wallets arrive in one tick, the later requests would
			// see no free wallet, conclude "no head" and be wrongly failed — when they
			// should just retry next tick once the wallet frees. Only a genuine
			// absence of any head fails a forced-Hydra request.
			let headAvailable = false;
			let headResolutionIndeterminate = false;
			let locked = false;
			for (const hotWallet of paymentContract.HotWallets) {
				if (!isHotWalletEligibleForL2Lock(request, hotWallet.id)) {
					continue;
				}
				let head;
				try {
					head = await resolveUsableHydraHeadForPurchase(hotWallet.id, request.sellerWalletId, paymentContract.network);
				} catch (error) {
					headResolutionIndeterminate = true;
					logger.warn('L2 lock: head resolution failed', { requestId: request.id, walletId: hotWallet.id, error });
					continue;
				}
				if (!head) {
					continue;
				}
				const provider = getHydraConnectionManager().getProvider(head.hydraHead.id);
				if (!provider) {
					// The persisted head exists, but this process temporarily has no live
					// provider. Treat that as indeterminate so a forced request retries
					// instead of being permanently failed during reconnect/startup.
					headResolutionIndeterminate = true;
					continue;
				}
				// A head exists for this pair — record it BEFORE the wallet-busy check so
				// a busy wallet never masquerades as "no head".
				headAvailable = true;
				// Re-read rather than trusting the snapshot this pass started with. A
				// wallet that just built a lock is busy for as long as that lock takes
				// to settle, and it frees again the moment it does — but the pass's own
				// copy still says busy, so it used to skip every remaining request and
				// leave them for the next nudge. With one buying wallet that capped the
				// whole queue at one lock per nudge, which is one per second, while the
				// head itself confirms in milliseconds.
				if (usedWalletIds.has(hotWallet.id)) continue;
				// Wait for a wallet this pass itself just used, rather than skipping it.
				// It is held from submit until the head confirms, which takes
				// milliseconds — but giving up on it ended the pass's useful work, and
				// the next one only starts on a nudge, rate-limited to one a second.
				// That, not Hydra, is what made a queue of escrows drain at 1/s.
				//
				// Only for wallets this pass used: one busy for any other reason
				// belongs to something else, and blocking on it would be waiting on
				// work this pass cannot see the end of.
				const tWait = Date.now();
				const free = await waitForFreeWallet(hotWallet.id, awaitingConfirmation.has(hotWallet.id));
				const waitMs = Date.now() - tWait;
				// The gap between one lock and the next, which is everything the
				// per-transaction timings above do not account for: the head
				// confirming, and this service noticing that it did.
				if (waitMs > 0) {
					logger.info('L2 lock wallet wait', { walletId: hotWallet.id, waitMs, free });
				}
				if (!free) {
					// Genuinely busy; another wallet may be free, and if none is the
					// request retries next tick (not failed).
					//
					// Withdrawn from the pass as well, when it was one we were willing
					// to wait for. A wallet whose confirmation never arrives does not
					// arrive any sooner for the next request either, and the wait is
					// three seconds each time: with a counterparty offline and fifty
					// queued locks that is two and a half minutes of the batch mutex
					// held for nothing, during which no L1 funds-lock is built at all.
					usedWalletIds.add(hotWallet.id);
					awaitingConfirmation.delete(hotWallet.id);
					continue;
				}

				try {
					const outcome = await executeL2Lock(request, paymentContract, hotWallet, head.hydraHead.id);
					// Accepted, accepted-but-not-finalized, and ambiguous outcomes all
					// retain the durable pre-submit reservation, so the request is
					// handled either way and neither another wallet nor this tick's L1
					// pass may touch it.
					//
					// The WALLET, though, is only withdrawn from this pass when its state
					// is in doubt. An ambiguous outcome leaves a reservation that only
					// Hydra reconciliation can settle, and building against that wallet
					// again would be building on an unknown balance. A clean outcome
					// releases it, and the re-read above will see that.
					if (outcome.status === 'ambiguous') usedWalletIds.add(hotWallet.id);
					else awaitingConfirmation.add(hotWallet.id);
					locked = true;
					if (outcome.status === 'ambiguous') {
						logger.warn('L2 funds-lock outcome ambiguous; reservation retained for Hydra reconciliation', {
							requestId: request.id,
							walletId: hotWallet.id,
							hydraHeadId: head.hydraHead.id,
							intendedTxHash: outcome.intendedTxHash,
							error: outcome.error instanceof Error ? outcome.error.message : outcome.error,
						});
					}
				} catch (error) {
					// executeL2Lock throws only before a reservation exists (build/sign or
					// atomic reservation failure). No body can have been submitted, so
					// another eligible wallet is safe.
					logger.warn('L2 funds-lock failed before submit reservation; trying another eligible wallet', {
						requestId: request.id,
						walletId: hotWallet.id,
						hydraHeadId: head.hydraHead.id,
						error: error instanceof Error ? error.message : error,
					});
					continue;
				}
				break; // request handled against its free head wallet
			}

			// Forced Hydra but NO usable open head exists for this buyer/seller pair at
			// all: fail loudly instead of silently falling back to L1. A head that
			// exists but whose wallet is merely busy this tick leaves `headAvailable`
			// true, so the request retries next tick rather than being failed.
			// Auto-routed, a head exists for this pair, and the only thing missing
			// was a free wallet this tick. Falling through to L1 here is what put an
			// unforced purchase on chain seconds after its head-bound sibling took
			// the wallet: the head was open the whole time. Defer it instead, and
			// only for as long as a wallet could plausibly free up — past that the
			// L1 pass takes it on the usual cadence rather than waiting forever.
			if (
				!forcedHydra &&
				!locked &&
				(headAvailable || headResolutionIndeterminate) &&
				Date.now() - request.createdAt.getTime() < AUTO_L2_DEFER_WINDOW_MS
			) {
				deferredRequestIds.push(request.id);
				logger.info('L2 lock: head is open but its wallet is busy; holding the request off L1 for now', {
					requestId: request.id,
				});
			}

			if (forcedHydra && !locked && !headAvailable && !headResolutionIndeterminate) {
				await failForcedL2Request(request, 'forceLayer=Hydra but no open head is available for this request');
			} else if (forcedHydra && !locked && headResolutionIndeterminate) {
				logger.info('L2 lock: Hydra availability is indeterminate; leaving forced request for retry', {
					requestId: request.id,
				});
			}
		}
	}

	return { deferredRequestIds };
}

/**
 * Fail a purchase request that forced Hydra when no head is available (or whose
 * buyer/seller force conflicts). Parks it in WaitingForManualAction with an error
 * so it is NOT picked up by the L1 pass and surfaces to the operator — mirrors
 * the timeout-invalidation write in tx-sync.
 */
async function failForcedL2Request(request: L2PurchaseRequest, reason: string): Promise<void> {
	logger.warn('L2 lock: failing forced-Hydra request', { requestId: request.id, reason });
	try {
		await prisma.purchaseRequest.update({
			where: { id: request.id, nextActionId: request.nextActionId },
			data: {
				ActionHistory: { connect: { id: request.nextActionId } },
				NextAction: {
					create: {
						requestedAction: PurchasingAction.WaitingForManualAction,
						errorType: PurchaseErrorType.Unknown,
						errorNote: reason,
					},
				},
			},
		});
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
			// The optimistic nextActionId guard raced. The other writer owns the
			// request now, so leave its state intact.
			logger.warn('L2 lock: failForcedL2Request update raced (guard miss); leaving to concurrent op', {
				requestId: request.id,
				nextActionId: request.nextActionId,
			});
			return;
		}
		throw error;
	}
}
