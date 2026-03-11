import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot } from '@meshsdk/core';

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
	} = {},
): TxWindow {
	const nowMs = options.nowMs ?? Date.now();
	const beforeBufferMs = options.beforeBufferMs ?? 150000;
	const afterBufferMs = options.afterBufferMs ?? 150000;
	const validitySlotBuffer = options.validitySlotBuffer ?? 5;

	const invalidBefore = unixTimeToEnclosingSlot(nowMs - beforeBufferMs, SLOT_CONFIG_NETWORK[network]) - 1;
	const defaultInvalidAfter = unixTimeToEnclosingSlot(nowMs + afterBufferMs, SLOT_CONFIG_NETWORK[network]) + validitySlotBuffer;

	if (options.constrainAfterMs == null) {
		return {
			invalidBefore,
			invalidAfter: defaultInvalidAfter,
		};
	}

	const constrainedInvalidAfter =
		unixTimeToEnclosingSlot(
			options.constrainAfterMs + afterBufferMs,
			SLOT_CONFIG_NETWORK[network],
		) + (options.constrainSlotBuffer ?? 3);

	return {
		invalidBefore,
		invalidAfter:
			(options.constrainStrategy ?? 'min') === 'max'
				? Math.max(defaultInvalidAfter, constrainedInvalidAfter)
				: Math.min(defaultInvalidAfter, constrainedInvalidAfter),
	};
}
