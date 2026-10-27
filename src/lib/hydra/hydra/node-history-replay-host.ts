import type { HydraProtocolError } from './errors';
import type * as l2Mint from './l2-mint-tally';
import type { HydraAccumulatorComputer } from './snapshot-accumulator-worker-client';
import type { DecommitSettledData, DepositRecordedData, HydraConfirmedTransaction } from './types';
import type { HydraSnapshotVerificationFrame } from './snapshot-verification';

/** What the replay needs from the session it serves. */
export interface HistoryReplayHost {
	readonly expectedHeadId: string | undefined;
	readonly trustLocalNodeSnapshotMetadata: boolean;
	/** The latched, instance-fatal rotation error, if one was ever observed. */
	readonly persistenceRotationError: HydraProtocolError | undefined;
	readonly orderedSnapshotVerificationKeys: string[] | undefined;
	/** Computes snapshot accumulators; defaults to the event loop. */
	readonly computeSnapshotAccumulator?: HydraAccumulatorComputer;
	/** Throws (and latches) when the frame announces event-log rotation. */
	assertPersistenceReplayIsSupported(message: unknown): void;
	bindSnapshotPartyOrder(message: unknown): void;
	verifyGreetingsPartyIdentity(message: unknown): void;
	setNetworkConnected(connected: boolean): void;
	/** Record a finalized fanout map, shared with the live session's copy. */
	recordFinalizedFanout(message: unknown): void;
	/** The pass closed on a headless Idle Greetings without having finalized the pinned head. */
	onIdleWithoutFinalization(): void;
	/** The pass accepted its closing Greetings, whether it is complete or a truncated page. */
	onPassClosed(): void;
	rememberReplayedDeposit(data: DepositRecordedData): void;
	rememberReplayedDecommit(data: DecommitSettledData): void;
	emitTxConfirmed(txId: string, transaction: HydraConfirmedTransaction): void;
	/** Persist the verified signed state before it becomes this pass's anchor. */
	persistVerifiedSnapshot?(frame: HydraSnapshotVerificationFrame): Promise<void>;
	reportL2MintOutstanding(incident: l2Mint.L2MintIncident): void;
	onProtocolDrift(description: string): void;
	/** Rotation is fatal for this client instance: tear down the live session and both transports. */
	onRotationReplayFailure(error: HydraProtocolError): void;
	/** The first failure of a pass: surface it (event + operator record). */
	onReplayFailed(error: Error): void;
}
