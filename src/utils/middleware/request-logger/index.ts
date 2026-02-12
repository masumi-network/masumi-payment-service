import { Request, Response, NextFunction } from 'express';
import { logger } from '@/utils/logger';
import {
	recordApiError,
	recordApiRequestDuration,
	recordBusinessEndpointError,
	isBusinessEndpoint,
} from '@/utils/metrics';

// Paths we skip for request logging and metrics (static assets, health, etc.)
const isNoisyPath = (url: string): boolean => {
	const pathname = url.includes('?') ? url.slice(0, url.indexOf('?')) : url;
	return (
		pathname.startsWith('/admin/_next/') ||
		pathname.startsWith('/_next/') ||
		pathname === '/favicon.ico' ||
		pathname === '/favicon.svg' ||
		pathname === '/health' ||
		pathname === '/admin'
	);
};

// Helper function to categorize errors by status code
const getErrorType = (statusCode: number): string => {
	if (statusCode >= 400 && statusCode < 500) {
		switch (statusCode) {
			case 400:
				return 'bad_request';
			case 401:
				return 'unauthorized';
			case 403:
				return 'forbidden';
			case 404:
				return 'not_found';
			case 409:
				return 'conflict';
			case 422:
				return 'validation_error';
			case 429:
				return 'rate_limit';
			default:
				return 'client_error';
		}
	} else if (statusCode >= 500) {
		switch (statusCode) {
			case 500:
				return 'internal_server_error';
			case 502:
				return 'bad_gateway';
			case 503:
				return 'service_unavailable';
			case 504:
				return 'gateway_timeout';
			default:
				return 'server_error';
		}
	}
	return 'unknown_error';
};

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
	const skip = isNoisyPath(req.url);

	if (!skip) {
		logger.info({
			method: req.method,
			url: req.url,
			ip: req.ip,
			userAgent: req.get('user-agent'),
			message: `Incoming ${req.method} request to ${req.url}`,
		});
	}

	res.on('finish', () => {
		const duration = req.startTime ? Date.now() - req.startTime : 0;
		const statusCode = res.statusCode;
		const isError = statusCode >= 400;
		const shouldLog = !skip || isError;

		if (shouldLog) {
			const isBusiness = isBusinessEndpoint(req.url);
			const logLevel = isError ? 'error' : 'info';
			logger[logLevel]({
				method: req.method,
				url: req.url,
				status: statusCode,
				duration: `${duration}ms`,
				business_endpoint: isBusiness,
				message: `${isError ? 'FAILED' : 'Completed'} ${req.method} ${req.url} with status ${statusCode} in ${duration}ms`,
				...(isError && {
					error_context: 'Request failed at middleware level',
				}),
			});
		}

		if (!skip) {
			recordApiRequestDuration(duration, req.url, req.method, statusCode, {});
		}

		if (isError) {
			const errorType = getErrorType(statusCode);
			recordApiError(req.url, req.method, statusCode, errorType, {});
			if (isBusinessEndpoint(req.url)) {
				const errorMessage = `HTTP ${statusCode} - ${getErrorType(statusCode)}`;
				recordBusinessEndpointError(req.url, req.method, statusCode, errorMessage, {});
			}
		}
	});

	next();
};
