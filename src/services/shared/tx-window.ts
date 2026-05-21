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
		constrainAfterMs?: number;
		constrainSlotBuffer?: number;
		constrainStrategy?: 'min' | 'max';
		// When set, ensures `invalidBefore` is no earlier than the slot
		// containing `constrainBeforeMs`. Use to satisfy Aiken
		// `must_start_after(validity_range, X)` checks (e.g. cooldowns).
		constrainBeforeMs?: number;
	} = {},
): TxWindow {
	const nowMs = options.nowMs ?? Date.now();
	const beforeBufferMs = options.beforeBufferMs ?? SERVICE_CONSTANTS.TRANSACTION.timeBufferMs;
	const afterBufferMs = options.afterBufferMs ?? SERVICE_CONSTANTS.TRANSACTION.timeBufferMs;
	const validitySlotBuffer = options.validitySlotBuffer ?? SERVICE_CONSTANTS.TRANSACTION.validitySlotBuffer;

	const defaultInvalidBefore = unixTimeToEnclosingSlot(nowMs - beforeBufferMs, SLOT_CONFIG_NETWORK[network]) - 1;
	const invalidBefore =
		options.constrainBeforeMs == null
			? defaultInvalidBefore
			: Math.max(
					defaultInvalidBefore,
					unixTimeToEnclosingSlot(options.constrainBeforeMs, SLOT_CONFIG_NETWORK[network]) + 1,
				);
	const defaultInvalidAfter =
		unixTimeToEnclosingSlot(nowMs + afterBufferMs, SLOT_CONFIG_NETWORK[network]) + validitySlotBuffer;

	if (options.constrainAfterMs == null) {
		return {
			invalidBefore,
			invalidAfter: defaultInvalidAfter,
		};
	}

	const constrainedInvalidAfter =
		unixTimeToEnclosingSlot(options.constrainAfterMs + afterBufferMs, SLOT_CONFIG_NETWORK[network]) +
		(options.constrainSlotBuffer ?? SERVICE_CONSTANTS.TRANSACTION.resultTimeSlotBuffer);

	return {
		invalidBefore,
		invalidAfter:
			(options.constrainStrategy ?? 'min') === 'max'
				? Math.max(defaultInvalidAfter, constrainedInvalidAfter)
				: Math.min(defaultInvalidAfter, constrainedInvalidAfter),
	};
}
