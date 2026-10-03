import { HydraHeadStatus } from '@/generated/prisma/client';
import { describeL2FundingBlock, L2_FUNDING_BLOCK_MESSAGE } from '@/utils/hydra/l2-funding-block';

describe('describeL2FundingBlock', () => {
	it('reports the block when an open head holds none of this wallet’s funds', () => {
		expect(describeL2FundingBlock(HydraHeadStatus.Open, { connected: true, utxoCount: 0 })).toBe(
			L2_FUNDING_BLOCK_MESSAGE,
		);
	});

	it('says nothing when the wallet has funds in the head', () => {
		expect(describeL2FundingBlock(HydraHeadStatus.Open, { connected: true, utxoCount: 1 })).toBeNull();
	});

	// One UTxO is enough to build with; the amount is not what this answers.
	it('says nothing for a single UTxO however many the head holds in total', () => {
		expect(describeL2FundingBlock(HydraHeadStatus.Open, { connected: true, utxoCount: 32 })).toBeNull();
	});

	// Unknown is not blocked. The connection fields reported next to this
	// already say the head could not be reached, and telling an operator to top
	// up a head nobody could read sends them to fix the wrong thing.
	it('says nothing when no live snapshot could be read', () => {
		expect(describeL2FundingBlock(HydraHeadStatus.Open, { connected: false, utxoCount: 0 })).toBeNull();
		expect(describeL2FundingBlock(HydraHeadStatus.Open, null)).toBeNull();
	});

	it('says nothing for a head that is not open', () => {
		for (const status of [
			HydraHeadStatus.Idle,
			HydraHeadStatus.Initializing,
			HydraHeadStatus.Closed,
			HydraHeadStatus.FanoutPossible,
			HydraHeadStatus.Final,
		]) {
			expect(describeL2FundingBlock(status, { connected: true, utxoCount: 0 })).toBeNull();
		}
	});
});
