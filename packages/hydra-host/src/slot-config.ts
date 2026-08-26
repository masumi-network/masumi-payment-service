/**
 * Slot arithmetic for converting a head-reported `currentSlot` into wall-clock
 * time, which is how drift is measured without parsing node logs.
 *
 * These are the Shelley-era parameters of each network: `zeroTime` is the ms
 * timestamp of `zeroSlot`, after which slots are one second.
 */

import type { SlotConfig } from './supervisor/drift.js';

const PREPROD: SlotConfig = {
	// Preprod Shelley transition: slot 86400 at 2022-06-21T00:00:00Z.
	zeroTime: Date.UTC(2022, 5, 21, 0, 0, 0),
	zeroSlot: 86_400,
	slotLength: 1_000,
};

const MAINNET: SlotConfig = {
	// Mainnet Shelley transition: slot 4492800 at 2020-07-29T21:44:51Z.
	zeroTime: Date.UTC(2020, 6, 29, 21, 44, 51),
	zeroSlot: 4_492_800,
	slotLength: 1_000,
};

export function resolveSlotConfig(network: 'preprod' | 'mainnet'): SlotConfig {
	return network === 'mainnet' ? MAINNET : PREPROD;
}
