import { logger } from '@/utils/logger';
import { checkLatestTransactions } from '@/services/transactions';
import { AsyncInterval } from '@/utils/async-interval';
import { checkRegistryTransactions } from '@/services/registry';
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
	await job.run();
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
