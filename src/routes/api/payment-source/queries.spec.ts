import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import { buildPaymentSourceListNetworkFilter } from './queries';

describe('buildPaymentSourceListNetworkFilter', () => {
	it('keeps the full network limit when filterNetwork is omitted', () => {
		expect(
			buildPaymentSourceListNetworkFilter({
				networkLimit: [Network.Preprod, Network.Mainnet],
			}),
		).toEqual({ in: [Network.Preprod, Network.Mainnet] });
	});

	it('narrows to a single network when filterNetwork is set', () => {
		expect(
			buildPaymentSourceListNetworkFilter({
				networkLimit: [Network.Preprod, Network.Mainnet],
				filterNetwork: Network.Preprod,
			}),
		).toEqual({ in: [Network.Preprod] });
	});

	it('does not widen access when filterNetwork is outside the key limit', () => {
		expect(
			buildPaymentSourceListNetworkFilter({
				networkLimit: [Network.Preprod],
				filterNetwork: Network.Mainnet,
			}),
		).toEqual({ in: [] });
	});
});
