import { describe, expect, it } from '@jest/globals';
import { DATABASE_AMOUNT_MESSAGE, HYDRA_QUANTITY_MESSAGE, withinDatabaseAmount, withinHydraQuantity } from './amounts';

const DATABASE_MAX = '9223372036854775807';
const HYDRA_MAX = '18446744073709551615';

// A value past these limits used to be answered `accepted` and then fail in the
// database write, with the driver's message and a server path stored as the
// reason. The check has to be a plain boolean: Zod runs a refinement even after
// the regex beside it failed, and `BigInt('abc')` throws.
describe.each([
	['withinDatabaseAmount', withinDatabaseAmount, DATABASE_MAX, '9223372036854775808'],
	['withinHydraQuantity', withinHydraQuantity, HYDRA_MAX, '18446744073709551616'],
])('%s', (_name, within, largest, oneMore) => {
	it('accepts the largest value', () => {
		expect(within(largest)).toBe(true);
	});

	it('refuses one more', () => {
		expect(within(oneMore)).toBe(false);
	});

	it('refuses a very long string', () => {
		expect(within('9'.repeat(100_000))).toBe(false);
	});

	it.each(['abc', '1.5', '-1', ' 1', '1e3', ''])('refuses %j without throwing', (value) => {
		expect(within(value)).toBe(false);
	});
});

describe('limit messages', () => {
	it('name the limit the caller went over', () => {
		expect(DATABASE_AMOUNT_MESSAGE).toContain(DATABASE_MAX);
		expect(HYDRA_QUANTITY_MESSAGE).toContain(HYDRA_MAX);
	});
});
