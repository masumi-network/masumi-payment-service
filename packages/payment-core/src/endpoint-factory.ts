import { HttpExistsError, allowedObjectSchema } from './http-exists-error';
import { EndpointsFactory, ensureHttpError, FlatObject, ResultHandler } from 'express-zod-api';
import createHttpError, { HttpError } from 'http-errors';

import { z } from './zod';
import { getOwnEntries, isPlainObject, type RuntimeObject, type RuntimePropertyValue } from './object-properties';

type ErrorLogger = {
	error: (message: string, meta: { error: HttpError; url: string; payload: FlatObject | null }) => unknown;
};

const getPublicErrorMessage = (error: HttpError): string =>
	process.env.NODE_ENV === 'production' && !error.expose
		? createHttpError(error.statusCode).message // default message for that code
		: error.message;

// Request payloads reach this logger verbatim on any 5xx, and several endpoints
// (e.g. payment-source-extended create/patch) carry plaintext wallet mnemonics
// and other secrets. Redact sensitive-looking keys before logging so seed
// phrases never land in log storage / the OpenTelemetry log bridge.
const SENSITIVE_KEY_PATTERN =
	/mnemonic|passphrase|password|secret|private[_-]?key|signing[_-]?key|seed|encryption[_-]?key|api[_-]?key|token/i;

const redactSensitive = (value: RuntimePropertyValue): RuntimePropertyValue => {
	if (Array.isArray(value)) {
		return value.map((entry) => redactSensitive(entry as RuntimePropertyValue));
	}
	if (isPlainObject(value)) {
		const redacted: RuntimeObject = {};
		for (const [key, entry] of getOwnEntries(value)) {
			redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSensitive(entry);
		}
		return redacted;
	}
	return value;
};

const logServerError = (error: HttpError, logger: ErrorLogger, url: string, payload: FlatObject | null) =>
	!error.expose &&
	logger.error('Server side error', { error, url, payload: redactSensitive(payload) as FlatObject | null });
const customResultHandler = new ResultHandler({
	positive: (output) => {
		const responseSchema = z.object({
			status: z.literal('success'),
			data: output,
		});

		return responseSchema;
	},
	negative: z
		.object({
			status: z.literal('error'),
			error: z.object({ message: z.string() }),
		})
		.example({
			status: 'error',
			error: { message: 'Sample error message' },
		})
		.or(
			z
				.object({
					status: z.literal('error'),
					error: z.object({ message: z.string() }),
					id: z.string(),
					object: allowedObjectSchema,
				})
				.example({
					status: 'error',
					error: { message: 'Sample error message' },
					id: '123',
					object: {
						id: '123',
						name: 'Sample name',
					},
				}),
		),
	handler: ({ error, input, output, request, response, logger }) => {
		if (error) {
			if (error instanceof HttpExistsError) {
				return void response.status(409).json({
					status: 'error',
					error: { message: error.message },
					id: error.id,
					object: error.object as z.infer<typeof allowedObjectSchema>,
				});
			}
			const httpError = ensureHttpError(error);

			logServerError(httpError, logger, request.url, input);
			return void response
				.status(httpError.statusCode)
				.set(httpError.headers)
				.json({
					status: 'error',
					error: { message: getPublicErrorMessage(httpError) },
				});
		}
		response.status(200).json({ status: 'success', data: output });
	},
});
const endpointFactory = new EndpointsFactory(customResultHandler);

export default endpointFactory;
