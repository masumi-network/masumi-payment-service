import { describe, expect, it } from '@jest/globals';
import { hasLegacyHydraAssetNames } from './hydra-legacy-value';
import type { HydraAmount } from './hydra-transaction-evidence';

const POLICY = 'ab'.repeat(28);
const ADA = { unit: 'lovelace', quantity: '4460850' };
const TOKEN_QUANTITY = '900000';
const token = (name: string, quantity = TOKEN_QUANTITY): HydraAmount => ({ unit: POLICY + name, quantity });

describe('hasLegacyHydraAssetNames', () => {
	it.each([
		['', '40'],
		['0014df105553444d', '480014df105553444d'],
		['ab'.repeat(23), '57' + 'ab'.repeat(23)],
		['ab'.repeat(24), '5818' + 'ab'.repeat(24)],
		['ab'.repeat(32), '5820' + 'ab'.repeat(32)],
	])('matches the exact legacy encoding of name %s', (rawName, oldName) => {
		expect(hasLegacyHydraAssetNames([ADA, token(oldName)], [token(rawName), ADA])).toBe(true);
	});

	it('preserves real names beginning with a CBOR-looking prefix', () => {
		expect(hasLegacyHydraAssetNames([ADA, token('4248aa')], [ADA, token('48aa')])).toBe(true);
		expect(hasLegacyHydraAssetNames([ADA, token('48aa')], [ADA, token('48aa')])).toBe(false);
		expect(hasLegacyHydraAssetNames([ADA, token('aa')], [ADA, token('48aa')])).toBe(false);
	});

	it('requires every native asset to match the complete legacy value', () => {
		const confirmed = [ADA, token('aa'), token('41aa')];
		expect(hasLegacyHydraAssetNames([token('4241aa'), ADA, token('41aa')], confirmed)).toBe(true);
		expect(hasLegacyHydraAssetNames([ADA, token('41aa'), token('41aa')], confirmed)).toBe(false);
		expect(hasLegacyHydraAssetNames([ADA, token('aa'), token('4241aa')], confirmed)).toBe(false);
		expect(hasLegacyHydraAssetNames(confirmed, confirmed)).toBe(false);
	});

	it('compares canonical whole values without changing caller arrays', () => {
		const persisted = [
			{ unit: '', quantity: '4460850' },
			token('41aa', '400000'),
			{ unit: (POLICY + '41aa').toUpperCase(), quantity: '500000' },
		];
		const confirmed = [token('aa'), ADA];
		const before = JSON.stringify({ persisted, confirmed });
		expect(hasLegacyHydraAssetNames(persisted, confirmed)).toBe(true);
		expect(JSON.stringify({ persisted, confirmed })).toBe(before);
	});

	it.each(
		[
			[ADA, token('41aa', '900001')],
			[{ ...ADA, quantity: '4460851' }, token('41aa')],
			[ADA, { unit: 'cd'.repeat(28) + '41aa', quantity: TOKEN_QUANTITY }],
			[ADA, token('41aa'), token('41bb')],
			[token('41aa')],
			[ADA],
		].map((persisted) => [persisted] as const),
	)('rejects quantity, policy, missing-asset, or extra-asset differences: %j', (persisted) => {
		expect(hasLegacyHydraAssetNames(persisted, [ADA, token('aa')])).toBe(false);
	});

	it.each(['ab'.repeat(27), POLICY + 'a', POLICY + 'gg', POLICY + 'ab'.repeat(33)])(
		'rejects malformed confirmed unit %s',
		(unit) => {
			expect(hasLegacyHydraAssetNames([ADA, token('41aa')], [ADA, { unit, quantity: TOKEN_QUANTITY }])).toBe(false);
		},
	);

	it.each(['-1', '1.5', 'not-a-quantity'])('rejects malformed quantity %s on either side', (quantity) => {
		expect(hasLegacyHydraAssetNames([ADA, token('41aa', quantity)], [ADA, token('aa')])).toBe(false);
		expect(hasLegacyHydraAssetNames([ADA, token('41aa')], [ADA, token('aa', quantity)])).toBe(false);
	});

	it('does not classify canonical, ADA-only, or empty values as legacy', () => {
		expect(hasLegacyHydraAssetNames([ADA, token('aa')], [ADA, token('aa')])).toBe(false);
		expect(hasLegacyHydraAssetNames([{ ...ADA, quantity: '1' }], [ADA])).toBe(false);
		expect(hasLegacyHydraAssetNames([ADA], [ADA])).toBe(false);
		expect(hasLegacyHydraAssetNames([], [])).toBe(false);
	});
});
