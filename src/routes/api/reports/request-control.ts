import type { AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';

const reportControlInputSchema = z.object({});
const REPORT_CONCURRENCY_LIMIT = 4;
export const REPORT_RESPONSE_TIMEOUT_MS = 5 * 60_000;
let activeReportRequests = 0;

export type ReportRequestContext = {
	reportAbortSignal: AbortSignal;
};

export type ReportConcurrencyContext = {
	runReportOperation: <T>(operation: (trackPendingWork: (work: Promise<unknown>) => void) => Promise<T>) => Promise<T>;
};

export const reportAbortMiddleware = new Middleware<
	AuthContext,
	ReportRequestContext,
	string,
	typeof reportControlInputSchema
>({
	input: reportControlInputSchema,
	handler: async ({ request, response }) => {
		const controller = new AbortController();
		const abortRequest = () => controller.abort();
		const clearListeners = () => {
			request.off('aborted', abortRequest);
			response.off('close', handleResponseClose);
			response.off('finish', clearListeners);
		};
		const handleResponseClose = () => {
			if (!response.writableEnded) abortRequest();
			clearListeners();
		};

		request.once('aborted', abortRequest);
		response.once('close', handleResponseClose);
		response.once('finish', clearListeners);
		if (request.aborted) abortRequest();

		return { reportAbortSignal: controller.signal };
	},
});

export const reportConcurrencyMiddleware = new Middleware<
	AuthContext & ReportRequestContext,
	ReportConcurrencyContext,
	string,
	typeof reportControlInputSchema
>({
	input: reportControlInputSchema,
	handler: async ({ response }) => {
		if (activeReportRequests >= REPORT_CONCURRENCY_LIMIT) {
			response.setHeader('Retry-After', '1');
			throw createHttpError(503, 'Report capacity reached. Retry later.');
		}

		activeReportRequests += 1;
		let hasStarted = false;
		let hasReleased = false;
		let hasResponseCompleted = false;
		let hasOperationSettled = false;
		const pendingWork = new Set<Promise<void>>();
		let responseDeadline: NodeJS.Timeout | null = null;
		const clearResponseDeadline = () => {
			if (responseDeadline == null) return;
			clearTimeout(responseDeadline);
			responseDeadline = null;
		};
		const release = () => {
			if (hasReleased) return;
			hasReleased = true;
			activeReportRequests -= 1;
			clearResponseDeadline();
			response.off('finish', handleResponseCompleted);
			response.off('close', handleResponseCompleted);
		};
		const releaseWhenComplete = () => {
			if (!hasStarted || (hasResponseCompleted && hasOperationSettled && pendingWork.size === 0)) release();
		};
		const handleResponseCompleted = () => {
			hasResponseCompleted = true;
			clearResponseDeadline();
			releaseWhenComplete();
		};
		response.once('finish', handleResponseCompleted);
		response.once('close', handleResponseCompleted);
		responseDeadline = setTimeout(() => {
			hasResponseCompleted = true;
			response.destroy();
			releaseWhenComplete();
		}, REPORT_RESPONSE_TIMEOUT_MS);
		responseDeadline.unref();
		const runReportOperation = async <T>(
			operation: (trackPendingWork: (work: Promise<unknown>) => void) => Promise<T>,
		): Promise<T> => {
			if (hasStarted) throw createHttpError(500, 'Report operation already started');
			hasStarted = true;
			if (hasReleased) {
				if (activeReportRequests >= REPORT_CONCURRENCY_LIMIT) {
					response.setHeader('Retry-After', '1');
					throw createHttpError(503, 'Report capacity reached. Retry later.');
				}
				activeReportRequests += 1;
				hasReleased = false;
			}
			const trackPendingWork = (work: Promise<unknown>) => {
				const settlement = work.then(
					() => undefined,
					() => undefined,
				);
				pendingWork.add(settlement);
				void settlement.finally(() => {
					pendingWork.delete(settlement);
					releaseWhenComplete();
				});
			};

			try {
				return await operation(trackPendingWork);
			} finally {
				hasOperationSettled = true;
				releaseWhenComplete();
			}
		};

		return { runReportOperation };
	},
});

export const privateReportResponseMiddleware = new Middleware<
	AuthContext,
	AuthContext,
	string,
	typeof reportControlInputSchema
>({
	input: reportControlInputSchema,
	handler: async ({ ctx, response }) => {
		response.setHeader('Cache-Control', 'private, no-store');
		response.vary('token');
		return ctx;
	},
});
