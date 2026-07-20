export function jsonToString(value: unknown): string {
	return JSON.stringify(
		value,
		(_, v) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			return typeof v === 'bigint' ? Number(v) : v;
		},
		2,
	);
}
