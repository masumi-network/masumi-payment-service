import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot } from '@meshsdk/core';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';

export type TxWindow = {
	invalidBefore: number;
	invalidAfter: number;
};

type SupportedMeshNetwork = 'mainnet' | 'preprod' | 'testnet' | 'preview';

export function createTxWindow(
	network: SupportedMeshNetwork,
	options: {
		nowMs?: number;
		beforeBufferMs?: number;
		afterBufferMs?: number;
		validitySlotBuffer?: number;
		// Accept bigint OR number so callers can pass decoded-datum values
		// directly (the contract decoder returns bigint for time fields).
		// Number(bigint) at call sites loses precision past ~9e15 ms and
		// silently produces NaN slots — always bigint-safe here.
		constrainAfterMs?: number | bigint;
		constrainSlotBuffer?: number;
		constrainStrategy?: 'min' | 'max';
		// When set, ensures `invalidBefore` is no earlier than the slot
		// containing `constrainBeforeMs`. Use to satisfy Aiken
		// `must_start_after(validity_range, X)` checks (e.g. cooldowns).
		constrainBeforeMs?: number | bigint;
	} = {},
): TxWindow {
	const nowMs = options.nowMs ?? Date.now();
	const beforeBufferMs = options.beforeBufferMs ?? SERVICE_CONSTANTS.TRANSACTION.timeBufferMs;
	const afterBufferMs = options.afterBufferMs ?? SERVICE_CONSTANTS.TRANSACTION.timeBufferMs;
	const validitySlotBuffer = options.validitySlotBuffer ?? SERVICE_CONSTANTS.TRANSACTION.validitySlotBuffer;

	// unixTimeToEnclosingSlot expects number. Convert bigint inputs here so
	// every callsite can pass the decoded-datum bigint as-is; values are
	// always millisecond unix timestamps that fit comfortably in number.
	const constrainBeforeMsNum =
		options.constrainBeforeMs == null
			? undefined
			: typeof options.constrainBeforeMs === 'bigint'
				? Number(options.constrainBeforeMs)
				: options.constrainBeforeMs;
	const constrainAfterMsNum =
		options.constrainAfterMs == null
			? undefined
			: typeof options.constrainAfterMs === 'bigint'
				? Number(options.constrainAfterMs)
				: options.constrainAfterMs;

	const defaultInvalidBefore = unixTimeToEnclosingSlot(nowMs - beforeBufferMs, SLOT_CONFIG_NETWORK[network]) - 1;
	const invalidBefore =
		constrainBeforeMsNum == null
			? defaultInvalidBefore
			: Math.max(defaultInvalidBefore, unixTimeToEnclosingSlot(constrainBeforeMsNum, SLOT_CONFIG_NETWORK[network]) + 1);
	const defaultInvalidAfter =
		unixTimeToEnclosingSlot(nowMs + afterBufferMs, SLOT_CONFIG_NETWORK[network]) + validitySlotBuffer;

	if (constrainAfterMsNum == null) {
		return {
			invalidBefore,
			invalidAfter: defaultInvalidAfter,
		};
	}

	// `constrainAfterMs` is a HARD deadline the tx must end strictly before
	// (Aiken `must_end_before(deadline)`). Anchor the upper bound just BELOW the
	// deadline (minus a slot safety margin), then take the tighter of this and
	// the default window via the `min` strategy. The previous formula ADDED
	// `afterBufferMs` (+5min) and the slot buffer, pushing the anchor well past
	// the deadline so `min` always kept the default (~now+5.5min) window — which
	// then overshot any deadline nearer than that and was rejected on-chain,
	// stranding near-deadline refunds / result submissions in manual action.
	const constrainedInvalidAfter =
		unixTimeToEnclosingSlot(constrainAfterMsNum, SLOT_CONFIG_NETWORK[network]) -
		(options.constrainSlotBuffer ?? SERVICE_CONSTANTS.TRANSACTION.resultTimeSlotBuffer);

	const invalidAfter =
		(options.constrainStrategy ?? 'min') === 'max'
			? Math.max(defaultInvalidAfter, constrainedInvalidAfter)
			: Math.min(defaultInvalidAfter, constrainedInvalidAfter);

	// A deadline nearer than (nowBuffer + slot safety margin) collapses the
	// window so invalidAfter <= invalidBefore. Submitting that inverted/empty
	// validity range is a guaranteed on-chain rejection (PPViewHashes aside, the
	// ledger requires lower < upper). Bail out with a clear error so the caller's
	// catch arm defers / routes to manual action instead of building a tx that
	// can never be valid.
	if (invalidAfter <= invalidBefore) {
		throw new Error(
			`createTxWindow: validity range collapsed (invalidBefore=${invalidBefore} >= invalidAfter=${invalidAfter}); ` +
				'deadline is too close to now to build a valid transaction',
		);
	}

	return {
		invalidBefore,
		invalidAfter,
	};
}
