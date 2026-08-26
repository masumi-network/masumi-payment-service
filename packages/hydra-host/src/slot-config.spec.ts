import { describe, expect, it } from '@jest/globals';
import { SLOT_CONFIG_NETWORK } from '@meshsdk/core';
import { resolveSlotConfig } from './slot-config.js';

// These constants are duplicated rather than imported so the Host container
// does not pull in the payment service's dependency graph. That duplication is
// only safe while it stays byte-identical to the canonical source, so assert it.
describe('resolveSlotConfig', () => {
	it('matches the canonical mesh slot config for preprod', () => {
		const mine = resolveSlotConfig('preprod');
		const canonical = SLOT_CONFIG_NETWORK.preprod;
		expect(mine.zeroTime).toBe(canonical.zeroTime);
		expect(mine.zeroSlot).toBe(canonical.zeroSlot);
		expect(mine.slotLength).toBe(canonical.slotLength);
	});

	it('matches the canonical mesh slot config for mainnet', () => {
		const mine = resolveSlotConfig('mainnet');
		const canonical = SLOT_CONFIG_NETWORK.mainnet;
		expect(mine.zeroTime).toBe(canonical.zeroTime);
		expect(mine.zeroSlot).toBe(canonical.zeroSlot);
		expect(mine.slotLength).toBe(canonical.slotLength);
	});
});
