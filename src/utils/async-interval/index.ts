/**
 * A class that implements an interval that waits for the previous execution to complete
 * before starting the next interval.
 */

export class AsyncInterval {
	private timeoutId: NodeJS.Timeout | null = null;
	private isRunning = false;
	private shouldStop = false;

	/**
	 * Creates an async interval that waits for the previous execution to complete
	 * @param callback The async function to execute
	 * @param intervalMs The interval in milliseconds between executions
	 * @returns A function to stop the interval
	 */
	static start(callback: () => Promise<void>, intervalMs: number): () => void {
		const instance = new AsyncInterval();
		void instance.run(callback, intervalMs);
		return () => instance.stop();
	}

	private async run(callback: () => Promise<void>, intervalMs: number): Promise<void> {
		if (this.isRunning) {
			return;
		}

		this.isRunning = true;
		this.shouldStop = false;

		while (!this.shouldStop) {
			try {
				await callback();
			} catch (error) {
				console.error('Error in async interval callback:', error);
			}

			if (this.shouldStop) {
				break;
			}

			await new Promise<void>((resolve) => {
				this.timeoutId = setTimeout(() => resolve(), intervalMs);
			});
		}

		this.isRunning = false;
		this.timeoutId = null;
	}

	private stop(): void {
		this.shouldStop = true;
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = null;
		}
	}
}
