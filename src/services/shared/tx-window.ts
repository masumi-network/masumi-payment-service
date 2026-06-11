import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot, type SlotConfig } from '@meshsdk/core';
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

	const defaultInvalidBefore = unixTimeToEnclosingSlot(nowMs - beforeBufferMs, slotConfig) - 1;
	const invalidBefore =
		constrainBeforeMsNum == null
			? defaultInvalidBefore
			: Math.max(defaultInvalidBefore, unixTimeToEnclosingSlot(constrainBeforeMsNum, slotConfig) + 1);
	const defaultInvalidAfter = unixTimeToEnclosingSlot(nowMs + afterBufferMs, slotConfig) + validitySlotBuffer;

	if (constrainAfterMsNum == null) {
		return {
			invalidBefore,
			invalidAfter: defaultInvalidAfter,
		};
	}

	const constrainedInvalidAfter =
		unixTimeToEnclosingSlot(constrainAfterMsNum + afterBufferMs, slotConfig) +
		(options.constrainSlotBuffer ?? SERVICE_CONSTANTS.TRANSACTION.resultTimeSlotBuffer);

	return {
		invalidBefore,
		invalidAfter:
			(options.constrainStrategy ?? 'min') === 'max'
				? Math.max(defaultInvalidAfter, constrainedInvalidAfter)
				: Math.min(defaultInvalidAfter, constrainedInvalidAfter),
	};
}
