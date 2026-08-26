/**
 * Deposit and withdrawal outcomes observed before the live session was
 * authenticated: held, bounded, and emitted exactly once when identity lands.
 *
 * A withdrawal settles on L1 minutes after it leaves the head, and a deposit
 * sits pending for a deposit period or more, so a service that reconnected in
 * between only ever meets their frames in the replayed history. Dropping them
 * left a withdrawal reading as still paying out forever, and a top-up with no
 * deadline at all. But emitting them before the session authenticates would
 * write outcomes to the database on the word of a socket whose identity was
 * never proven — so they wait here.
 */

import { DecommitSettledData, DepositRecordedData } from './types';

/**
 * How many replayed outcomes are worth holding.
 *
 * A head replays its entire history on every connection; only the tail can
 * still describe a settlement this service has not finished recording.
 */
const MAX_HELD_BACK_OUTCOMES = 32;

export class HeldBackEmissions {
	private _decommits: DecommitSettledData[] = [];
	/**
	 * Keyed by deposit id rather than appended, because the same deposit is
	 * replayed on every connection and re-emitting it costs a write each time.
	 */
	private readonly _deposits = new Map<string, DepositRecordedData>();

	rememberDecommit(data: DecommitSettledData): void {
		this._decommits.push(data);
		if (this._decommits.length > MAX_HELD_BACK_OUTCOMES) this._decommits.shift();
	}

	rememberDeposit(data: DepositRecordedData): void {
		this._deposits.set(data.depositTxId, data);
		if (this._deposits.size > MAX_HELD_BACK_OUTCOMES) {
			const oldest = this._deposits.keys().next();
			if (!oldest.done) this._deposits.delete(oldest.value);
		}
	}

	/**
	 * Emit what was held back, oldest first, exactly once.
	 *
	 * Order matters: an approval must not be applied after the finalization
	 * that followed it, and the settlement code relies on seeing them in the
	 * order the head produced them.
	 */
	flushDecommits(emit: (data: DecommitSettledData) => void): void {
		if (this._decommits.length === 0) return;
		const pending = this._decommits;
		this._decommits = [];
		for (const data of pending) emit(data);
	}

	flushDeposits(emit: (data: DepositRecordedData) => void): void {
		if (this._deposits.size === 0) return;
		const pending = [...this._deposits.values()];
		this._deposits.clear();
		for (const data of pending) emit(data);
	}

	/**
	 * Forget everything. Whatever was held came over a socket whose identity
	 * has just been rejected; keeping it would mean applying, on the next
	 * authenticated session, outcomes this node never accepted.
	 */
	clear(): void {
		this._decommits = [];
		this._deposits.clear();
	}
}
