import type { AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';

const reportControlInputSchema = z.object({});
export const REPORT_CONCURRENCY_LIMIT = 4;
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
		const armResponseDeadline = () => {
			responseDeadline = setTimeout(() => {
				hasResponseCompleted = true;
				response.destroy();
				// `release()`, not `releaseWhenComplete()`. The deadline is the only
				// bound on how long one request can hold a slot, and an operation
				// that never settles leaves `hasOperationSettled` false for ever, so
				// the conditional release can never fire. The response is destroyed
				// above, so nothing is still being delivered to a client. Work that
				// settles later re-enters `release()` and returns on `hasReleased`.
				release();
			}, REPORT_RESPONSE_TIMEOUT_MS);
			responseDeadline.unref();
		};
		response.once('finish', handleResponseCompleted);
		response.once('close', handleResponseCompleted);
		armResponseDeadline();
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
				// `release()` cleared the deadline and removed both response
				// listeners, and the response has already completed, so nothing is
				// left to free this slot. Without a fresh timer an operation that
				// never settles holds it for the lifetime of the process and the
				// effective concurrency limit drops by one for good.
				armResponseDeadline();
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
