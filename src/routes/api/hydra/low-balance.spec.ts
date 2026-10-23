import { beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@/services/hydra-low-balance/rules', () => ({
	deleteHydraLowBalanceRule: jest.fn(),
	listHydraLowBalanceRules: jest.fn(),
	upsertHydraLowBalanceRule: jest.fn(),
}));

let setHydraLowBalanceRuleSchemaInput: { safeParse: (input: unknown) => { success: boolean } };

beforeAll(async () => {
	({ setHydraLowBalanceRuleSchemaInput } = (await import('./low-balance')) as never);
});

const rule = { hydraLocalParticipantId: 'participant-1', assetUnit: 'lovelace' };

// Both amounts are BigInt columns, for a token as much as for lovelace, so one
// limit covers the unit.
describe('low-balance amount limit', () => {
	it.each(['thresholdAmount', 'topupAmount'])('holds %s to what a BigInt column holds', (field) => {
		const base = { ...rule, thresholdAmount: '1' };
		expect(setHydraLowBalanceRuleSchemaInput.safeParse({ ...base, [field]: '9223372036854775807' }).success).toBe(true);
		expect(setHydraLowBalanceRuleSchemaInput.safeParse({ ...base, [field]: '9223372036854775808' }).success).toBe(
			false,
		);
	});

	it('still accepts a zero threshold', () => {
		expect(setHydraLowBalanceRuleSchemaInput.safeParse({ ...rule, thresholdAmount: '0' }).success).toBe(true);
	});

	it('refuses a non-number cleanly', () => {
		expect(setHydraLowBalanceRuleSchemaInput.safeParse({ ...rule, thresholdAmount: 'abc' }).success).toBe(false);
	});
});
