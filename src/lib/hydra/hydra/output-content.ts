/**
 * One string per output content. The selection holds schema-parsed outputs
 * (BigInt quantities, absent optional fields) and a frame holds raw JSON
 * (numbers, explicit nulls), so both are reduced to sorted keys, quantities
 * as decimal strings and no null fields.
 */
export function canonicalOutputContent(output: unknown): string {
	const canonical = (value: unknown): unknown => {
		if (typeof value === 'bigint' || typeof value === 'number') return value.toString();
		if (Array.isArray(value)) return value.map(canonical);
		if (typeof value !== 'object' || value == null) return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry != null)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	};
	return JSON.stringify(canonical(output));
}
