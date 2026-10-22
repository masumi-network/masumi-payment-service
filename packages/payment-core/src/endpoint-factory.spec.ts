import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';
import createHttpError from 'http-errors';
import { sendEndpointError } from './endpoint-factory';

function send(error: Error) {
	const logError = jest.fn();
	const response = { status: () => response, set: () => response, json: () => response };
	sendEndpointError({
		error,
		input: null,
		request: { url: '/api/v1/hydra/head/retire' },
		response: response as unknown as Response,
		logger: { error: logError },
	});
	return logError;
}

describe('sendEndpointError logging', () => {
	// Exposing a 5xx message to the operator must not also hide it from the log.
	it('logs an exposed 5xx', () => {
		expect(send(createHttpError(503, 'Could not read the remaining UTxO set', { expose: true }))).toHaveBeenCalledTimes(
			1,
		);
	});

	it('does not log a 4xx', () => {
		expect(send(createHttpError(404, 'Hydra head not found'))).not.toHaveBeenCalled();
	});
});
