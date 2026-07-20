import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot, type SlotConfig } from '@meshsdk/core';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';

export type TxWindow = {
	invalidBefore: number;
	invalidAfter: number;
	// Unix-ms of the END of the `invalidAfter` slot — the `tx_latest_time` the
	// on-chain validator sees. Datum fields derived from the validity upper
	// bound (vested_pay: `new cooldown >= tx_latest_time + cooldown_period`)
	// must be computed from THIS, not from `Date.now()`, or the check fails
	// whenever the window is not anchored to the caller's wall clock (Hydra
	// head-clock windows, shrunk buffers).
	invalidAfterMs: number;
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
		// Override the slot config used to convert unix times → slots. Defaults
		// to the static config for `network`, which is correct for L1 and for a
		// Hydra head that settles on that same L1 (e.g. a preprod head uses
		// preprod slots). A head on a different chain (e.g. a local devnet with
		// its own genesis) must supply its slot config here, or the window lands
		// on slots the head's ledger rejects (`OutsideValidityIntervalUTxO`).
		slotConfig?: SlotConfig;
	} = {},
): TxWindow {
	const nowMs = options.nowMs ?? Date.now();
	const slotConfig = options.slotConfig ?? SLOT_CONFIG_NETWORK[network];
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

	const slotEndMs = (slot: number) => (slot + 1 - slotConfig.zeroSlot) * slotConfig.slotLength + slotConfig.zeroTime;

	const defaultInvalidBefore = unixTimeToEnclosingSlot(nowMs - beforeBufferMs, slotConfig) - 1;
	const invalidBefore =
		constrainBeforeMsNum == null
			? defaultInvalidBefore
			: Math.max(defaultInvalidBefore, unixTimeToEnclosingSlot(constrainBeforeMsNum, slotConfig) + 1);
	const defaultInvalidAfter = unixTimeToEnclosingSlot(nowMs + afterBufferMs, slotConfig) + validitySlotBuffer;

	if (constrainAfterMsNum == null) {
		// When `constrainBeforeMs` pushes the lower bound forward (e.g. a
		// cooldown that expires just ahead of `nowMs`), the default upper bound
		// can land only a handful of slots above it — a window the validating
		// node's clock may never observe (seen on a Hydra head lagging its L1:
		// [127319734, 127319738] = 4 slots → OutsideValidityIntervalUTxO).
		// No `constrainAfterMs` means no contract constraint on the upper
		// bound, so widening it is always safe: keep at least the default
		// buffer's width above `invalidBefore`.
		const minWindowSlots = validitySlotBuffer + Math.ceil((beforeBufferMs + afterBufferMs) / 1000);
		const wideInvalidAfter = Math.max(defaultInvalidAfter, invalidBefore + minWindowSlots);
		return {
			invalidBefore,
			invalidAfter: wideInvalidAfter,
			invalidAfterMs: slotEndMs(wideInvalidAfter),
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
		unixTimeToEnclosingSlot(constrainAfterMsNum, slotConfig) -
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
		invalidAfterMs: slotEndMs(invalidAfter),
	};
}
