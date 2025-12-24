import {
  HttpExistsError,
  allowedObjectSchema,
} from '@/utils/errors/http-exists-error';
import {
  EndpointsFactory,
  ensureHttpError,
  FlatObject,
  ResultHandler,
} from 'express-zod-api';
import createHttpError, { HttpError } from 'http-errors';

import { z } from '@/utils/zod-openapi';
export const getPublicErrorMessage = (error: HttpError): string =>
  process.env.NODE_ENV === 'production' && !error.expose
    ? createHttpError(error.statusCode).message // default message for that code
    : error.message;
export const logServerError = (
  error: HttpError,
  logger: any,
  url: string,
  payload: FlatObject | null,
) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  !error.expose && logger.error('Server side error', { error, url, payload });
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          object: error.object,
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
