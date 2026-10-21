import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import { assertDeveloperTestPaymentAllowed } from './developer-test-payments';

describe('assertDeveloperTestPaymentAllowed', () => {
	it('allows Mainnet when developerTestIntent is omitted', () => {
		expect(() =>
			assertDeveloperTestPaymentAllowed({ network: Network.Mainnet }),
		).not.toThrow();
	});

	it('allows Preprod when developerTestIntent is true', () => {
		expect(() =>
			assertDeveloperTestPaymentAllowed({
				network: Network.Preprod,
				developerTestIntent: true,
			}),
		).not.toThrow();
	});

	it('rejects Mainnet when developerTestIntent is true', () => {
		expect(() =>
			assertDeveloperTestPaymentAllowed({
				network: Network.Mainnet,
				developerTestIntent: true,
			}),
		).toThrow(
			expect.objectContaining({
				statusCode: 403,
				message: expect.stringContaining('Developer test payments'),
			}),
		);
	});
});
