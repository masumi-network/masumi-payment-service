export function exhaustiveFallback<T>(_value: never, fallback: T): T {
	return fallback;
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled discriminated union value: ${JSON.stringify(value)}`);
}
