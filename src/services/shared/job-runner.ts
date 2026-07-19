import { Mutex, tryAcquire } from 'async-mutex';
import { logger } from '@/utils/logger';

export type JobDefinition = {
	initialDelayMs: number;
	intervalMs: number;
	startMessage: string;
	run: () => Promise<void>;
	finishMessage?: string;
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
