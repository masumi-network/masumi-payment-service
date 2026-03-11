export function assertNever(value: never, message: string): never {
	throw new Error(`${message}: ${String(value)}`);
}

export function exhaustiveFallback<T>(value: never, fallback: T): T {
	return fallback;
}
