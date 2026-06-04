import { logger } from '@masumi/payment-core/logger';
import { checkLatestTransactions } from '@/services/transactions';
import { AsyncInterval } from '@/utils/async-interval';
import { checkRegistryTransactions } from '@masumi/payment-source-v1/services/registry/tx-sync/service';
import { scheduledJobs } from './jobs';
import type { JobDefinition } from '@/services/shared';

const startupTimers = new Set<NodeJS.Timeout>();
const activeJobStops = new Set<() => Promise<void>>();
let jobsInitialized = false;
let jobsInitializationPromise: Promise<void> | null = null;
let jobsInitializationToken = 0;

async function runScheduledJob(job: JobDefinition) {
	logger.info(job.startMessage);
	const start = Date.now();
	try {
		await job.run();
	} catch (error) {
		// Swallow with loud log: an uncaught throw bubbles into
		// AsyncInterval's tick handler. Depending on the AsyncInterval
		// implementation, a throw can either skip the next iteration or
		// stop scheduling entirely for that job — neither is acceptable
		// since the scheduler MUST keep running. We surface the error so
		// operators see it, but keep the interval alive.
		logger.error(`Scheduled job '${job.startMessage}' threw; interval kept alive`, {
			error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
			durationMs: Date.now() - start,
		});
		return;
	}
	if (job.finishMessage) {
		logger.info(job.finishMessage + ' in ' + (Date.now() - start) / 1000 + 's');
	}
}

function scheduleJob(job: JobDefinition) {
	if (!jobsInitialized) {
		return;
	}

	const timer = setTimeout(() => {
		startupTimers.delete(timer);
		if (!jobsInitialized) {
			return;
		}

		const stop = AsyncInterval.start(async () => runScheduledJob(job), job.intervalMs);
		activeJobStops.add(stop);
	}, job.initialDelayMs);

	startupTimers.add(timer);
}

export async function initJobs() {
	if (jobsInitialized) {
		logger.warn('Async intervals are already initialized');
		return;
	}

	if (jobsInitializationPromise) {
		logger.warn('Async intervals are already initializing');
		await jobsInitializationPromise;
		return;
	}

	const initializationToken = ++jobsInitializationToken;
	const initializationPromise = (async () => {
		const start = new Date();
		await new Promise((resolve) => setTimeout(resolve, 500));
		await checkLatestTransactions();
		await checkRegistryTransactions();
		logger.info('Checked and synced transactions in ' + (new Date().getTime() - start.getTime()) / 1000 + 's');

		if (initializationToken !== jobsInitializationToken) {
			return;
		}

		jobsInitialized = true;
		scheduledJobs.forEach(scheduleJob);

		await new Promise((resolve) => setTimeout(resolve, 200));
		if (initializationToken !== jobsInitializationToken || !jobsInitialized) {
			return;
		}

		logger.info('Initialized async intervals');
	})();

	jobsInitializationPromise = initializationPromise;

	try {
		await initializationPromise;
	} finally {
		if (jobsInitializationPromise === initializationPromise) {
			jobsInitializationPromise = null;
		}
	}
}

export async function stopJobs() {
	jobsInitializationToken += 1;
	jobsInitialized = false;

	for (const timer of startupTimers) {
		clearTimeout(timer);
	}
	startupTimers.clear();

	const jobStops = Array.from(activeJobStops);
	activeJobStops.clear();
	await Promise.allSettled(jobStops.map((stop) => stop()));

	logger.info('Stopped async intervals');
}
