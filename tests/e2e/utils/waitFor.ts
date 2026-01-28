export interface WaitForOptions {
	timeout?: number;
	interval?: number;
	description?: string;
}

export interface WaitForResult<T> {
	success: boolean;
	result?: T;
	error?: Error;
	attempts: number;
	elapsed: number;
}

/**
 * Generic waitFor utility that polls a condition until it's met or timeout
 */
export async function waitFor<T>(
	condition: () => Promise<T | false | null | undefined>,
	options: WaitForOptions = {},
): Promise<WaitForResult<T>> {
	const {
		timeout = 300000, // 5 minutes default
		interval = 5000, // 5 seconds default
		description = 'condition to be met',
	} = options;

	const startTime = Date.now();
	let attempts = 0;
	let lastError: Error | undefined;

	console.log(`⏳ Waiting for ${description} (timeout: ${timeout}ms, interval: ${interval}ms)`);

	while (Date.now() - startTime < timeout) {
		attempts++;

		try {
			console.log(`🔄 Attempt ${attempts}: Checking ${description}...`);
			const result = await condition();

			if (result) {
				const elapsed = Date.now() - startTime;
				console.log(`✅ Success after ${attempts} attempts (${elapsed}ms): ${description}`);
				return {
					success: true,
					result: result as T,
					attempts,
					elapsed,
				};
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			console.log(`❌ Attempt ${attempts} failed: ${lastError.message}`);
		}

		// Wait before next attempt
		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	const elapsed = Date.now() - startTime;
	console.log(`⏰ Timeout after ${attempts} attempts (${elapsed}ms): ${description}`);

	return {
		success: false,
		error: lastError || new Error(`Timeout waiting for ${description}`),
		attempts,
		elapsed,
	};
}

/**
 * Wait for server to be ready
 */
export async function waitForServer(
	apiClient: { healthCheck: () => Promise<unknown> },
	options: WaitForOptions = {},
): Promise<WaitForResult<boolean>> {
	return waitFor(
		async () => {
			try {
				await apiClient.healthCheck();
				return true;
			} catch (error) {
				console.log(`🏥 Server health check failed: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
		},
		{
			timeout: 60000, // 1 minute default for server startup
			interval: 2000, // Check every 2 seconds
			...options,
			description: 'server to be ready',
		},
	);
}

export default waitFor;
