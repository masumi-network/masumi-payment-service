export function exhaustiveFallback<T>(_value: never, fallback: T): T {
	return fallback;
}
