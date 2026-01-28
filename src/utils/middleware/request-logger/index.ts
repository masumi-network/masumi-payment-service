import { Request, Response, NextFunction } from 'express';
import { logger } from '@/utils/logger';
import {
	recordApiError,
	recordApiRequestDuration,
	recordBusinessEndpointError,
	isBusinessEndpoint,
} from '@/utils/metrics';

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
	// Log request details
	logger.info({
		method: req.method,
		url: req.url,
		ip: req.ip,
		userAgent: req.get('user-agent'),
		message: `Incoming ${req.method} request to ${req.url}`,
	});

	// Add response listener to log the response and record metrics
	res.on('finish', () => {
		const duration = req.startTime ? Date.now() - req.startTime : 0;
		const statusCode = res.statusCode;

		// Enhanced logging for business endpoints
		const isBusiness = isBusinessEndpoint(req.url);
		const logLevel = statusCode >= 400 ? 'error' : 'info';

		logger[logLevel]({
			method: req.method,
			url: req.url,
			status: statusCode,
			duration: `${duration}ms`,
			business_endpoint: isBusiness,
			message: `${statusCode >= 400 ? 'FAILED' : 'Completed'} ${req.method} ${req.url} with status ${statusCode} in ${duration}ms`,
			...(statusCode >= 400 && {
				error_context: 'Request failed at middleware level',
			}),
		});

		// Record API request duration for all requests (this metric works)
		recordApiRequestDuration(duration, req.url, req.method, statusCode, {
			user_agent: req.get('user-agent') || 'unknown',
			ip: req.ip || 'unknown',
		});

		// Record error metrics for failed requests
		if (statusCode >= 400) {
			const errorType = getErrorType(statusCode);

			// Record general API error (existing system)
			recordApiError(req.url, req.method, statusCode, errorType, {
				duration,
				user_agent: req.get('user-agent') || 'unknown',
				ip: req.ip || 'unknown',
			});

			// Record business endpoint error with detailed information
			if (isBusiness) {
				// Try to get error details from response body or create generic error
				const errorMessage = `HTTP ${statusCode} - ${getErrorType(statusCode)}`;
				recordBusinessEndpointError(req.url, req.method, statusCode, errorMessage, {
					duration,
					user_agent: req.get('user-agent') || 'unknown',
					ip: req.ip || 'unknown',
					error_source: 'middleware',
				});
			}
		}
	});

	next();
};
