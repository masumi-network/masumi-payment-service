import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { authMiddleware } from '@masumi/payment-core/auth-middleware';
import { endpointErrorResponseSchema, sendEndpointError } from '@masumi/payment-core/endpoint-factory';
import { z } from '@masumi/payment-core/zod';
import { EndpointsFactory, ResultHandler } from 'express-zod-api';
import {
	REPORT_CSV_CONTENT_TYPE,
	REPORT_ZIP_CONTENT_TYPE,
	type StagedReportArtifact,
} from '@/services/transaction-report/export-files';

const MAX_DOWNLOAD_FILENAME_LENGTH = 255;

const cleanupSchema = z.custom<StagedReportArtifact['cleanup']>(
	(value) => typeof value === 'function',
	'Cleanup must be a function',
);

export const reportExportArtifactSchema = z.object({
	filePath: z.string().min(1),
	filename: z
		.string()
		.min(1)
		.max(MAX_DOWNLOAD_FILENAME_LENGTH)
		.refine(
			(filename) =>
				!filename.includes('/') &&
				!filename.includes('\\') &&
				[...filename].every((character) => {
					const codePoint = character.codePointAt(0) ?? 0;
					return codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
				}),
			'Invalid download filename',
		),
	contentType: z.enum([REPORT_CSV_CONTENT_TYPE, REPORT_ZIP_CONTENT_TYPE]),
	contentLength: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	cleanup: cleanupSchema,
});

export const reportExportArtifactPassThroughSchema = z.custom<StagedReportArtifact>();

function encodeRfc5987Value(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export function createAttachmentHeader(filename: string): string {
	const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '\\$&');
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

const binaryResponseSchema = z.string().meta({ format: 'binary' });

async function cleanupReportArtifact(
	value: unknown,
	logger: { error: (message: string, meta: { error: unknown }) => unknown },
): Promise<void> {
	let cleanup: unknown;
	try {
		cleanup =
			(typeof value === 'object' && value !== null) || typeof value === 'function'
				? Reflect.get(value, 'cleanup')
				: undefined;
	} catch (cleanupLookupError) {
		logger.error('Report export cleanup failed', { error: cleanupLookupError });
		return;
	}

	if (typeof cleanup !== 'function') {
		return;
	}

	try {
		await Reflect.apply(cleanup, value, []);
	} catch (cleanupError) {
		logger.error('Report export cleanup failed', { error: cleanupError });
	}
}

export const reportExportResultHandler = new ResultHandler({
	positive: [
		{ schema: binaryResponseSchema, mimeType: REPORT_CSV_CONTENT_TYPE },
		{ schema: binaryResponseSchema, mimeType: REPORT_ZIP_CONTENT_TYPE },
	],
	negative: endpointErrorResponseSchema,
	handler: async ({ error, input, output, request, response, logger }) => {
		if (error) {
			sendEndpointError({ error, input, request, response, logger });
			return;
		}

		const rejectInvalidArtifact = async (validationError: Error): Promise<void> => {
			try {
				sendEndpointError({ error: validationError, input, request, response, logger });
			} finally {
				await cleanupReportArtifact(output, logger);
			}
		};

		let artifactResult: ReturnType<typeof reportExportArtifactSchema.safeParse>;
		try {
			artifactResult = reportExportArtifactSchema.safeParse(output);
		} catch (validationError) {
			await rejectInvalidArtifact(
				validationError instanceof Error ? validationError : new Error('Invalid report export artifact'),
			);
			return;
		}
		if (!artifactResult.success) {
			await rejectInvalidArtifact(artifactResult.error);
			return;
		}
		const artifact = artifactResult.data;

		try {
			// Open the staged file before staging 200 and the download headers. A
			// stream that fails to open after them left the client with an aborted
			// empty 200 whose Content-Length did not match the body, which reads as
			// a valid but empty export. Once headers are sent there is no way back,
			// so a mid-stream failure still only destroys the response.
			const fileStream = createReadStream(artifact.filePath);
			try {
				await once(fileStream, 'open');
			} catch (openError) {
				fileStream.destroy();
				logger.error('Report export stream failed', { error: openError });
				sendEndpointError({
					error: openError instanceof Error ? openError : new Error('Report export could not be read'),
					input,
					request,
					response,
					logger,
				});
				return;
			}
			response.status(200).set({
				'Content-Type': artifact.contentType,
				'Content-Disposition': createAttachmentHeader(artifact.filename),
				'Content-Length': String(artifact.contentLength),
				'Cache-Control': 'no-store',
			});
			await pipeline(fileStream, response);
		} catch (streamError) {
			logger.error('Report export stream failed', { error: streamError });
		} finally {
			await cleanupReportArtifact(artifact, logger);
		}
	},
});

export const readAuthenticatedReportExportEndpointFactory = new EndpointsFactory(
	reportExportResultHandler,
).addMiddleware(authMiddleware({ canRead: true }));
