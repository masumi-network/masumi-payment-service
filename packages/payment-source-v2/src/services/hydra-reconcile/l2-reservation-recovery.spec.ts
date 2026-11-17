import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	Address,
	BigNum,
	PlutusData,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import {
	HydraHeadStatus,
	Network,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import {
	canReportExpiredL2Reservation,
	EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS,
	L2_ACTION_RELEASE_GRACE_MS,
	L2_RESERVATION_EXPIRY_GRACE_MS,
	L2_RESERVATION_RELEASE_GRACE_MS,
	reportExpiredL2Reservations,
} from './l2-reservation-recovery';
import { encodeL2ReleaseNudgeDatum, readL2ReleaseNudgeProof } from './l2-release-nudge-proof';
import { L2_RELEASE_NUDGE_INTERVAL_MS } from './l2-reservation-nudge';

const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
const nowMs = 2_000_000;
const expiryMs = BigInt(nowMs - L2_RESERVATION_EXPIRY_GRACE_MS - 1);

const WALLET_ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';

/** A signed-shape release nudge over `inputs`, as `signInHeadSpendNudge` builds it. */
function nudgeTxOver(inputs: string[], nonceByte = 1): string {
	const txInputs = TransactionInputs.new();
	for (const reference of inputs) {
		const [txHash, index] = reference.split('#');
		txInputs.add(TransactionInput.new(TransactionHash.from_hex(txHash), Number(index)));
	}
	const output = TransactionOutput.new(Address.from_bech32(WALLET_ADDRESS), Value.new(BigNum.from_str('10000000')));
	output.set_plutus_data(PlutusData.from_hex(encodeL2ReleaseNudgeDatum(new Uint8Array(32).fill(nonceByte))));
	const outputs = TransactionOutputs.new();
	outputs.add(output);
	return Transaction.new(
		TransactionBody.new_tx_body(txInputs, outputs, BigNum.zero()),
		TransactionWitnessSet.new(),
	).to_hex();
}

function safeGate() {
	return {
		hasVerifiedPinnedSessions: true,
		historyReady: true,
		queuedTransactions: 0,
		headClock: { chainTimeMs: nowMs, receivedAtMs: nowMs },
		nowMs,
		validityUpperBoundTimeMs: expiryMs,
	};
}

describe('expired L2 reservation reporting gate', () => {
	it('reports only after the signed TTL plus grace', () => {
		expect(canReportExpiredL2Reservation(safeGate())).toBe(true);
		expect(
			canReportExpiredL2Reservation({
				...safeGate(),
				validityUpperBoundTimeMs: BigInt(nowMs - L2_RESERVATION_EXPIRY_GRACE_MS),
			}),
		).toBe(false);
	});

	it.each([
		['unpinned identity', { hasVerifiedPinnedSessions: false }],
		['partial history', { historyReady: false }],
		['queued causal evidence', { queuedTransactions: 1 }],
		['missing signed expiry', { validityUpperBoundTimeMs: null }],
		['stale live clock', { headClock: { chainTimeMs: nowMs, receivedAtMs: nowMs - 60_001 } }],
		['future live clock', { headClock: { chainTimeMs: nowMs + 5_001, receivedAtMs: nowMs } }],
	] as const)('fails closed for %s', (_label, override) => {
		expect(canReportExpiredL2Reservation({ ...safeGate(), ...override })).toBe(false);
	});
});

describe('expired L2 reservation reporting', () => {
	const recoveryNowMs = Date.UTC(2026, 6, 23, 12, 0, 0);
	const expirySlot = BigInt(
		unixTimeToEnclosingSlot(recoveryNowMs - L2_RESERVATION_EXPIRY_GRACE_MS - 5_000, SLOT_CONFIG_NETWORK.preprod),
	);

	beforeEach(() => {
		warnSpy.mockClear();
	});

	function harness(
		options: {
			candidateCount?: number;
			confirmed?: boolean;
			currentTxHash?: string | null;
			initialLock?: boolean;
			/** Paid funds on the purchase an initial lock reserves. */
			paidFunds?: Array<{ unit: string; amount: bigint }>;
			rejected?: boolean;
			inputRefs?: string[];
			unspentRefs?: string[];
			pendingCommitRefs?: string[];
			idPrefix?: string;
			nudgeTx?: string | null;
			/** Exact bytes the verified snapshot holds at a reference, over `unspentRefs`. */
			outputs?: Map<string, string>;
		} = {},
	) {
		const intendedTxHash = 'a'.repeat(64);
		// `number` is the verified snapshot the service sees.
		const snapshot = { number: 7n };
		const unspent = new Set(options.unspentRefs ?? options.inputRefs ?? []);
		const outputs = new Map(options.outputs ?? []);
		const database = {
			transaction: {
				findMany: jest.fn(async () =>
					Array.from({ length: options.candidateCount ?? 1 }, (_, index) => ({
						id: `${options.idPrefix ?? 'reservation'}-${index + 1}`,
						intendedTxHash,
						txHash: options.currentTxHash ?? null,
						invalidHereafterSlot: expirySlot,
						l2ReservationPreviousTransactionId: options.initialLock ? null : 'previous-transaction',
						l2RejectedByHeadAt: options.rejected ? new Date(recoveryNowMs - 120_000) : null,
						l2ReservationInputRefs: options.inputRefs ?? [],
						l2ReleaseNudgeTx: options.nudgeTx ?? null,
						l2ReservationPreviousLayer: null,
						l2ReservationPreviousSmartContractWalletId: null,
						l2ReservationPreviousBuyerReturnAddress: null,
						l2ReservationPreviousCollateralReturn: null,
						PaymentRequestCurrent: [],
						PurchaseRequestCurrent: [{ PaidFunds: options.paidFunds ?? [{ unit: '', amount: 10_000_000n }] }],
					})),
				),
			},
			$transaction: jest.fn(),
			hydraHead: {
				findUnique: jest.fn(async () => ({ status: HydraHeadStatus.Open, isClosing: false })),
			},
		};
		const node = {
			status: HydraHeadStatus.Open as HydraHeadStatus,
			hasVerifiedPinnedSessions: true,
			confirmedTransactionHistoryReady: true,
			headClock: { chainTimeMs: recoveryNowMs, receivedAtMs: recoveryNowMs },
			// Release reads the node's verified snapshot. The persisted head tip
			// is never advanced by snapshot confirmations, so the harness has none.
			get verifiedSnapshotNumber(): bigint | undefined {
				return snapshot.number;
			},
			getConfirmedTransactionsForReconciliation: jest.fn(() => []),
			getConfirmedTransaction: jest.fn(() => (options.confirmed ? { txId: intendedTxHash } : null)),
			getVerifiedCurrentOutput: jest.fn((reference: string, number: bigint) => {
				if (number !== snapshot.number) return null;
				return outputs.get(reference) ?? (unspent.has(reference) ? 'output-bytes' : null);
			}),
		};
		// Stubbed so no test reaches a live head; the deadlock tests drive it.
		const nudge = jest.fn(async (_candidate: unknown): Promise<unknown> => true);
		return { database, node, snapshot, unspent, outputs, nudge };
	}

	it.each([
		['intended-only', null],
		['TxValid', 'a'.repeat(64)],
	] as const)(
		'retains an expired %s reservation because replay absence is not negative proof',
		async (_label, txHash) => {
			const h = harness({ currentTxHash: txHash });
			await expect(
				reportExpiredL2Reservations({
					hydraHeadId: 'head-1',
					network: Network.Preprod,
					node: h.node as never,
					nowMs: recoveryNowMs,
					database: h.database as never,
				}),
			).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		},
	);

	it('also retains initial locks because replay absence cannot prove wallet inputs unspent', async () => {
		const h = harness({ initialLock: true });
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-1',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(1);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('retains an expired rejected initial lock because a node can withhold an earlier accepted snapshot', async () => {
		const h = harness({ initialLock: true, rejected: true });
		const mutationClient = {
			transaction: {
				findUnique: jest.fn(async () => ({
					status: TransactionStatus.Pending,
					txHash: null,
					l2RejectedByHeadAt: new Date(recoveryNowMs - 120_000),
					PurchaseRequestCurrent: [{ id: 'purchase-1', nextActionId: 'action-1' }],
				})),
				update: jest.fn(),
			},
			hotWallet: { updateMany: jest.fn() },
			purchaseRequest: { update: jest.fn() },
		};
		h.database.$transaction.mockImplementation(
			async (callback: unknown) =>
				await (callback as (client: typeof mutationClient) => Promise<unknown>)(mutationClient),
		);
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-rejected-initial-lock',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(1);
		expect(h.database.$transaction).not.toHaveBeenCalled();
		expect(mutationClient.transaction.update).not.toHaveBeenCalled();
		expect(mutationClient.hotWallet.updateMany).not.toHaveBeenCalled();
		expect(mutationClient.purchaseRequest.update).not.toHaveBeenCalled();
	});

	it('leaves confirmed evidence to the ordered replay path', async () => {
		const h = harness({ confirmed: true });
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-1',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(0);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('aggregates all expired reservations for one head into one bounded warning', async () => {
		const h = harness({ candidateCount: 3 });
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-warning-aggregate',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(3);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]).toEqual([
			expect.any(String),
			expect.objectContaining({
				expiredReservationCount: 3,
				transactionIdSamples: ['reservation-1', 'reservation-2', 'reservation-3'],
			}),
		]);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('throttles repeated warnings without mutating the reservation', async () => {
		const h = harness();
		const run = async (atMs: number) => {
			h.node.headClock = { chainTimeMs: atMs, receivedAtMs: atMs };
			return await reportExpiredL2Reservations({
				hydraHeadId: 'head-warning-throttle',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: atMs,
				database: h.database as never,
			});
		};

		await expect(run(recoveryNowMs)).resolves.toBe(1);
		await expect(run(recoveryNowMs)).resolves.toBe(1);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		await expect(run(recoveryNowMs + EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS)).resolves.toBe(1);
		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('does not inspect reservations before authenticated history is ready', async () => {
		const h = harness();
		h.node.confirmedTransactionHistoryReady = false;
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-1',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(0);
		expect(h.database.transaction.findMany).not.toHaveBeenCalled();
	});

	describe('proven-dead release', () => {
		const refs = [`${'b'.repeat(64)}#0`, `${'c'.repeat(64)}#1`];
		const nudgeTx = nudgeTxOver(refs);
		const floor = [{ unit: '', amount: 10_000_000n }];
		const proof = readL2ReleaseNudgeProof(nudgeTx, refs, floor);
		if (!proof) throw new Error('fixture nudge must pass the proof');
		// Far enough past expiry for the release grace, not only the report grace.
		const releaseNowMs = recoveryNowMs + L2_RESERVATION_RELEASE_GRACE_MS;

		function withMutations(h: ReturnType<typeof harness>, recordedNudgeTx: string | null = nudgeTx) {
			const mutationClient = {
				transaction: {
					findUnique: jest.fn(async () => ({
						status: TransactionStatus.Pending,
						txHash: null,
						l2RejectedByHeadAt: null,
						l2ReleaseNudgeTx: recordedNudgeTx,
						// Release tests reserve an initial lock: only those carry a value floor.
						PurchaseRequestCurrent: [
							{
								id: 'purchase-1',
								nextActionId: 'action-1',
								NextAction: { requestedAction: PurchasingAction.FundsLockingInitiated },
							},
						],
						PaymentRequestCurrent: [],
					})),
					update: jest.fn(),
				},
				hotWallet: { updateMany: jest.fn() },
				purchaseRequest: { update: jest.fn() },
				paymentRequest: { update: jest.fn() },
			};
			h.database.$transaction.mockImplementation(
				async (callback: unknown) =>
					await (callback as (client: typeof mutationClient) => Promise<unknown>)(mutationClient),
			);
			return mutationClient;
		}

		function scan(h: ReturnType<typeof harness>, hydraHeadId: string, atMs = releaseNowMs) {
			h.node.headClock = { chainTimeMs: atMs, receivedAtMs: atMs };
			return reportExpiredL2Reservations({
				hydraHeadId,
				network: Network.Preprod,
				node: h.node as never,
				nowMs: atMs,
				database: h.database as never,
				nudge: h.nudge,
			});
		}

		it('nudges a reservation with no nudge yet, and holds it', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'first' });
			withMutations(h);
			await expect(scan(h, 'head-first')).resolves.toBe(1);
			expect(h.nudge).toHaveBeenCalledWith({
				id: 'first-1',
				l2ReservationInputRefs: refs,
				l2ReleaseNudgeTx: null,
				valueFloor: floor,
			});
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('releases once the recorded nudge output is in the verified snapshot', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'release', nudgeTx });
			const mutationClient = withMutations(h);

			// Not applied yet: the nudge is resent, nothing is freed.
			await expect(scan(h, 'head-release')).resolves.toBe(1);
			expect(h.nudge).toHaveBeenCalledWith(expect.objectContaining({ l2ReleaseNudgeTx: nudgeTx }));
			expect(h.database.$transaction).not.toHaveBeenCalled();

			h.snapshot.number = 8n;
			h.outputs.set(proof.reference, proof.serializedOutput);
			await expect(scan(h, 'head-release')).resolves.toBe(0);
			expect(mutationClient.hotWallet.updateMany).toHaveBeenCalledWith({
				where: { pendingTransactionId: 'release-1' },
				data: { lockedAt: null, pendingTransactionId: null },
			});
			expect(mutationClient.transaction.update).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: TransactionStatus.RolledBack,
						l2ReleasedByInputProofAt: expect.any(Date),
					}),
				}),
			);
		});

		// The reported finding, end to end: every input reads as unspent (twin
		// outputs under spent references), on a newer snapshot, past expiry.
		// The old reference proof released here. Nothing is freed now.
		it('never releases on inputs that only read as unspent', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'twins', nudgeTx });
			withMutations(h);
			await expect(scan(h, 'head-twins')).resolves.toBe(1);
			h.snapshot.number = 8n;
			await expect(scan(h, 'head-twins')).resolves.toBe(1);
			h.snapshot.number = 9n;
			await expect(scan(h, 'head-twins')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds when the nudge reference holds other bytes', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'other-bytes', nudgeTx });
			withMutations(h);
			h.outputs.set(proof.reference, 'other-output-bytes');
			await expect(scan(h, 'head-other-bytes')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		// The body applied first: it spent the inputs, the head refused the nudge,
		// and its output never appears. The row stays held and is reported.
		it('holds a reservation whose body applied before the nudge', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, unspentRefs: [], idPrefix: 'applied', nudgeTx });
			withMutations(h);
			h.snapshot.number = 8n;
			await expect(scan(h, 'head-applied')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds a recorded nudge that spends an input the body does not', async () => {
			const foreign = nudgeTxOver([refs[0], `${'9'.repeat(64)}#0`]);
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'foreign', nudgeTx: foreign });
			withMutations(h, foreign);
			const shape = readL2ReleaseNudgeProof(foreign, [refs[0], `${'9'.repeat(64)}#0`], floor);
			if (!shape) throw new Error('fixture must parse');
			h.outputs.set(shape.reference, shape.serializedOutput);
			await expect(scan(h, 'head-foreign')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('refuses the release when the row now records a different nudge', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'swapped', nudgeTx });
			const mutationClient = withMutations(h, nudgeTxOver(refs, 2));
			h.outputs.set(proof.reference, proof.serializedOutput);
			await expect(scan(h, 'head-swapped')).resolves.toBe(1);
			expect(mutationClient.hotWallet.updateMany).not.toHaveBeenCalled();
		});

		it('holds and does not nudge while the node has no verified snapshot', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'unverified', nudgeTx });
			withMutations(h);
			Object.defineProperty(h.node, 'verifiedSnapshotNumber', { get: () => undefined });
			h.outputs.set(proof.reference, proof.serializedOutput);
			await expect(scan(h, 'head-unverified')).resolves.toBe(1);
			expect(h.nudge).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('retains reservations recorded before inputs were stored, without nudging', async () => {
			const h = harness({ initialLock: true, inputRefs: [], idPrefix: 'legacy' });
			withMutations(h);
			await expect(scan(h, 'head-legacy')).resolves.toBe(1);
			expect(h.nudge).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		// The floor is what makes copying the nonce output cost at least what a
		// false release redirects. A nudge below it proves nothing.
		it('holds when the nudge output is below the purchase paid funds', async () => {
			const h = harness({
				initialLock: true,
				inputRefs: refs,
				idPrefix: 'below-floor',
				nudgeTx,
				paidFunds: [{ unit: '', amount: 10_000_001n }],
			});
			withMutations(h);
			h.outputs.set(proof.reference, proof.serializedOutput);
			await expect(scan(h, 'head-below-floor')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		// Only an initial lock has a floor from our records. Any other row is
		// never nudged and never auto-released.
		it('neither nudges nor releases a non-locking action', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action', nudgeTx });
			withMutations(h);
			h.outputs.set(proof.reference, proof.serializedOutput);
			await expect(scan(h, 'head-action')).resolves.toBe(1);
			expect(h.nudge).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('neither nudges nor releases inside the release grace', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'grace', nudgeTx });
			withMutations(h);
			h.outputs.set(proof.reference, proof.serializedOutput);
			await expect(scan(h, 'head-grace', recoveryNowMs)).resolves.toBe(1);
			expect(h.nudge).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});
	});

	// A non-locking action (here a collect-refund) has no nudge: its escrow input
	// is a script UTxO. It is released only when the node's LIVE state (never
	// replay) shows one of its inputs unspent and no round in flight.
	describe('unapplied action release', () => {
		const escrowRef = `${'d'.repeat(64)}#0`;
		const walletRef = `${'e'.repeat(64)}#2`;
		const refs = [escrowRef, walletRef];
		const actionNowMs = recoveryNowMs + L2_ACTION_RELEASE_GRACE_MS;
		const idleRound = {
			inFlight: false,
			tag: 'NoSeenSnapshot',
			number: null,
			signatoryCount: 0,
			txIds: [],
			signature: 'x',
		};
		const live = (liveRefs: string[], round: object = idleRound) => ({ round, liveRefs: new Set(liveRefs) });

		function withActionMutations(h: ReturnType<typeof harness>) {
			const mutationClient = {
				transaction: {
					findUnique: jest.fn(async () => ({
						status: TransactionStatus.Pending,
						txHash: null,
						l2ReleaseNudgeTx: null,
						PurchaseRequestCurrent: [
							{
								id: 'purchase-1',
								nextActionId: 'action-1',
								NextAction: { requestedAction: PurchasingAction.WithdrawRefundInitiated },
							},
						],
						PaymentRequestCurrent: [],
					})),
					update: jest.fn(),
				},
				hotWallet: { updateMany: jest.fn() },
				purchaseRequest: { update: jest.fn() },
				paymentRequest: { update: jest.fn() },
			};
			h.database.$transaction.mockImplementation(
				async (callback: unknown) =>
					await (callback as (client: typeof mutationClient) => Promise<unknown>)(mutationClient),
			);
			return mutationClient;
		}

		function scan(
			h: ReturnType<typeof harness>,
			hydraHeadId: string,
			readLiveSnapshot: () => Promise<unknown> = async () => live(refs),
			atMs = actionNowMs,
			isCurrentNode = () => true,
		) {
			h.node.headClock = { chainTimeMs: atMs, receivedAtMs: atMs };
			return reportExpiredL2Reservations({
				hydraHeadId,
				network: Network.Preprod,
				node: h.node as never,
				nowMs: atMs,
				database: h.database as never,
				nudge: h.nudge,
				readLiveSnapshot: readLiveSnapshot as never,
				isCurrentNode,
			});
		}

		it('releases an expired action with an unspent input and no round in flight', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-release' });
			const mutationClient = withActionMutations(h);
			await expect(scan(h, 'head-action-release')).resolves.toBe(0);
			const update = mutationClient.transaction.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
			expect(update.data).toEqual(
				expect.objectContaining({
					status: TransactionStatus.RolledBack,
					l2ReleasedByUnspentInputsAt: expect.any(Date),
				}),
			);
			// An automatic release is never recorded as an admin decision.
			expect(update.data).not.toHaveProperty('l2ReleasedByOperatorAt');
			expect(mutationClient.hotWallet.updateMany).toHaveBeenCalledWith({
				where: { pendingTransactionId: 'action-release-1' },
				data: { lockedAt: null, pendingTransactionId: null },
			});
			// Back to its retry action, on the escrow transaction it replaced.
			expect(mutationClient.purchaseRequest.update).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						CurrentTransaction: { connect: { id: 'previous-transaction' } },
					}),
				}),
			);
			expect(h.nudge).not.toHaveBeenCalled();
		});

		// The stuck refund case: another body already spent the escrow, so this one
		// can never land. Its wallet input is still live, which proves it did not.
		it('releases when the escrow is spent but a wallet input is still live', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-escrow-spent' });
			withActionMutations(h);
			await expect(scan(h, 'head-action-escrow-spent', async () => live([walletRef]))).resolves.toBe(0);
			expect(h.database.$transaction).toHaveBeenCalledTimes(1);
		});

		// The 2026-10-22 shape: replay is stuck on an old snapshot that still maps
		// every input, while the live node already shows them spent.
		it('holds when replay still maps the inputs but the live snapshot has spent them all', async () => {
			const h = harness({ inputRefs: refs, unspentRefs: refs, idPrefix: 'action-stale-replay' });
			withActionMutations(h);
			await expect(scan(h, 'head-action-stale-replay', async () => live([]))).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('reads the live snapshot once per scan for every action candidate', async () => {
			const h = harness({ candidateCount: 3, inputRefs: refs, idPrefix: 'action-many' });
			withActionMutations(h);
			const readLive = jest.fn(async () => live([]));
			await expect(scan(h, 'head-action-many', readLive)).resolves.toBe(3);
			expect(readLive).toHaveBeenCalledTimes(1);
		});

		it('holds inside the action release grace', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-grace' });
			withActionMutations(h);
			const readLive = jest.fn(async () => live(refs));
			await expect(
				scan(h, 'head-action-grace', readLive, recoveryNowMs + L2_RESERVATION_RELEASE_GRACE_MS),
			).resolves.toBe(1);
			expect(readLive).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds while a snapshot round is in flight', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-round' });
			withActionMutations(h);
			const seen = { ...idleRound, inFlight: true, tag: 'SeenSnapshot', number: 8 };
			await expect(scan(h, 'head-action-round', async () => live(refs, seen))).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds, warning once per scan, when the live snapshot cannot be read', async () => {
			const h = harness({ candidateCount: 3, inputRefs: refs, idPrefix: 'action-unread' });
			withActionMutations(h);
			await expect(
				scan(h, 'head-action-unread', async () => {
					throw new Error('node unreachable');
				}),
			).resolves.toBe(3);
			expect(h.database.$transaction).not.toHaveBeenCalled();
			const readWarnings = warnSpy.mock.calls.filter(([message]) =>
				String(message).includes('could not read the live snapshot'),
			);
			expect(readWarnings).toHaveLength(1);
			// A failed read starts no throttle window: the next scan tries again.
			const readLive = jest.fn(async () => live([]));
			await expect(scan(h, 'head-action-unread', readLive, actionNowMs + 1)).resolves.toBe(3);
			expect(readLive).toHaveBeenCalledTimes(1);
		});

		it('holds on a missing verified snapshot', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-unverified' });
			withActionMutations(h);
			Object.defineProperty(h.node, 'verifiedSnapshotNumber', { get: () => undefined });
			await expect(scan(h, 'head-action-unverified')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		// After a close, a contest can carry a snapshot our node signed but never
		// saw complete, so the live state no longer proves the body did not apply.
		it('holds when the head is no longer open', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-closed' });
			withActionMutations(h);
			h.node.status = HydraHeadStatus.Closed;
			const readLive = jest.fn(async () => live(refs));
			await expect(scan(h, 'head-action-closed', readLive)).resolves.toBe(1);
			expect(readLive).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds while the head row is closing', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-closing' });
			withActionMutations(h);
			h.database.hydraHead.findUnique.mockResolvedValue({ status: HydraHeadStatus.Open, isClosing: true });
			const readLive = jest.fn(async () => live(refs));
			await expect(scan(h, 'head-action-closing', readLive)).resolves.toBe(1);
			expect(readLive).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds when the head row starts closing while the snapshot is read', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-closing-late' });
			withActionMutations(h);
			h.database.hydraHead.findUnique
				.mockResolvedValueOnce({ status: HydraHeadStatus.Open, isClosing: false })
				.mockResolvedValue({ status: HydraHeadStatus.Open, isClosing: true });
			await expect(scan(h, 'head-action-closing-late')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds when the node session was replaced during the read', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-reconnect' });
			withActionMutations(h);
			await expect(scan(h, 'head-action-reconnect', undefined, actionNowMs, () => false)).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		// A round in flight is no answer, so it starts no throttle window.
		it('reads again on the next scan after a round in flight', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-busy' });
			withActionMutations(h);
			const seen = { ...idleRound, inFlight: true, tag: 'SeenSnapshot', number: 8 };
			const readLive = jest.fn(async () => live(refs, seen));
			await expect(scan(h, 'head-action-busy', readLive)).resolves.toBe(1);
			await expect(scan(h, 'head-action-busy', readLive, actionNowMs + 1)).resolves.toBe(1);
			expect(readLive).toHaveBeenCalledTimes(2);
		});

		// An action whose inputs are all spent never releases; it must not cost a
		// full UTxO fetch on every reconcile tick.
		it('reads the live snapshot at most once per nudge interval per head', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-throttle' });
			withActionMutations(h);
			const readLive = jest.fn(async () => live([]));
			await expect(scan(h, 'head-action-throttle', readLive)).resolves.toBe(1);
			await expect(scan(h, 'head-action-throttle', readLive, actionNowMs + 60_000)).resolves.toBe(1);
			expect(readLive).toHaveBeenCalledTimes(1);
			await expect(scan(h, 'head-action-throttle', readLive, actionNowMs + L2_RELEASE_NUDGE_INTERVAL_MS)).resolves.toBe(
				1,
			);
			expect(readLive).toHaveBeenCalledTimes(2);
		});

		it('holds when the body shows up in confirmed history after the snapshot was read', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'action-late' });
			withActionMutations(h);
			// Null at the scan's own check, confirmed by the time the snapshot came back.
			h.node.getConfirmedTransaction.mockReturnValueOnce(null).mockReturnValue({ txId: 'a'.repeat(64) } as never);
			await expect(scan(h, 'head-action-late')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('holds an action recorded before inputs were stored', async () => {
			const h = harness({ inputRefs: [], idPrefix: 'action-legacy' });
			withActionMutations(h);
			await expect(scan(h, 'head-action-legacy')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		// The same evidence never frees an initial lock: only its nudge does.
		it('never frees an initial lock on live unspent inputs and an idle round', async () => {
			const h = harness({ initialLock: true, inputRefs: refs, idPrefix: 'lock-unspent' });
			withActionMutations(h);
			const readLive = jest.fn(async () => live(refs));
			await expect(scan(h, 'head-lock-unspent', readLive)).resolves.toBe(1);
			expect(readLive).not.toHaveBeenCalled();
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});
	});
});
