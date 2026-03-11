import { logger } from '@/utils/logger';
import { checkLatestTransactions } from '@/services/transactions';
import { AsyncInterval } from '@/utils/async-interval';
import { checkRegistryTransactions } from '@/services/registry';
import { scheduledJobs } from './jobs';
import type { JobDefinition } from '@/services/shared';

const startupTimers = new Set<NodeJS.Timeout>();
const activeJobStops = new Set<() => Promise<void>>();
let jobsInitialized = false;

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

	jobsInitialized = true;

	const start = new Date();
	await new Promise((resolve) => setTimeout(resolve, 500));
	await checkLatestTransactions();
	await checkRegistryTransactions();
	logger.info('Checked and synced transactions in ' + (new Date().getTime() - start.getTime()) / 1000 + 's');

	if (!jobsInitialized) {
		return;
	}

	scheduledJobs.forEach(scheduleJob);

	await new Promise((resolve) => setTimeout(resolve, 200));
	logger.info('Initialized async intervals');
}

export async function stopJobs() {
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
