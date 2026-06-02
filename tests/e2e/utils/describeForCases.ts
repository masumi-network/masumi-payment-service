/**
 * `describe.each` that survives an empty `cases` array.
 *
 * Jest's `describe.each([])` throws "called with an empty Array of table
 * data" at load time, which fails the suite before any test runs. Our e2e
 * workflow shards by `TEST_PAYMENT_SOURCE_TYPE` (V1 vs V2) — a V1-only
 * suite picked up by the V2 runner (or vice versa) legitimately has zero
 * applicable cases. In that case we still need the file to load cleanly so
 * the rest of the matrix passes, hence the placeholder skipped describe.
 */
export function describeEachOrSkip<T>(
	cases: readonly T[],
	reason: string,
	title: string,
	fn: (item: T) => void,
): void {
	if (cases.length === 0) {
		describe.skip(`${title} — skipped: ${reason}`, () => {
			it('not applicable for this runner', () => {});
		});
		return;
	}
	describe.each(cases)(title, fn);
}
