import { Mutex, tryAcquire } from 'async-mutex';
import { logger } from '@masumi/payment-core/logger';

export type JobDefinition = {
	initialDelayMs: number;
	intervalMs: number;
	startMessage: string;
	run: () => Promise<void>;
	finishMessage?: string;
	/**
	 * Whether this tick has anything to do, asked before the job starts.
	 *
	 * For work that belongs to a feature a deployment may not use. The interval
	 * still ticks — the feature can be adopted while the service runs — but a
	 * false answer skips the job and its logging entirely, so an unused feature
	 * costs one cheap question instead of a full pass over its tables.
	 */
	shouldRun?: () => Promise<boolean>;
};

export async function withJobLock<T>(
	mutex: Mutex,
	jobName: string,
	operation: () => Promise<T>,
): Promise<T | undefined> {
	let release: (() => void) | undefined;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info(`${jobName} is already running, skipping cycle`);
		return undefined;
	}

	try {
		return await operation();
	} finally {
		release?.();
	}
}
