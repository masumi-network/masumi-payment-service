export async function timedFetch(url: string, timeoutMs = 7500): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
		try {
			controller.abort();
		} catch {
			// no-op on a completed request
		}
	}
}
