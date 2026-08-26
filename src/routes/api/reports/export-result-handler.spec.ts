import { jest } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { Request, Response } from 'express';
import { testEndpoint } from 'express-zod-api';
import createHttpError from 'http-errors';
import { HttpExistsError } from '@masumi/payment-core/http-exists-error';
import { z } from '@masumi/payment-core/zod';
import {
	REPORT_CSV_CONTENT_TYPE,
	REPORT_ZIP_CONTENT_TYPE,
	type StagedReportArtifact,
} from '@/services/transaction-report/export-files';
import {
	createAttachmentHeader,
	readAuthenticatedReportExportEndpointFactory,
	reportExportArtifactPassThroughSchema,
	reportExportArtifactSchema,
	reportExportResultHandler,
} from './export-result-handler';

type TestLogger = {
	debug: jest.Mock;
	info: jest.Mock;
	warn: jest.Mock;
	error: jest.Mock;
};

class TestResponse extends Writable {
	readonly chunks: Buffer[] = [];
	readonly headers = new Map<string, string>();
	jsonBody: unknown;
	statusCode = 200;

	constructor(private readonly disconnectOnWrite = false) {
		super();
	}

	status(code: number): this {
		this.statusCode = code;
		return this;
	}

	set(field: string | Record<string, unknown> | undefined, value?: unknown): this {
		if (typeof field === 'string') {
			this.headers.set(field.toLowerCase(), String(value));
			return this;
		}
		for (const [name, headerValue] of Object.entries(field ?? {})) {
			if (headerValue != null) {
				this.headers.set(name.toLowerCase(), String(headerValue));
			}
		}
		return this;
	}

	json(body: unknown): this {
		this.jsonBody = body;
		this.end(JSON.stringify(body));
		return this;
	}

	get bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}

	_write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		callback();
		if (this.disconnectOnWrite) {
			this.destroy();
		}
	}
}

function createLogger(): TestLogger {
	return {
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	};
}

async function executeSuccess(
	artifact: StagedReportArtifact | Record<string, unknown>,
	response: TestResponse,
	logger: TestLogger,
): Promise<void> {
	await reportExportResultHandler.execute({
		output: artifact,
		error: null,
		input: {},
		ctx: {},
		request: { url: '/api/v1/reports/transactions.csv' } as Request,
		response: response as unknown as Response,
		logger: logger as never,
	});
}

async function executeError(
	error: Error,
	response: TestResponse,
	logger: TestLogger,
	input: Record<string, unknown> = {},
): Promise<void> {
	await reportExportResultHandler.execute({
		output: null,
		error,
		input,
		ctx: {},
		request: { url: '/api/v1/reports/transactions.csv' } as Request,
		response: response as unknown as Response,
		logger: logger as never,
	});
}

describe('report export result handler', () => {
	let testDirectory: string;

	beforeEach(async () => {
		jest.clearAllMocks();
		testDirectory = await mkdtemp(join(tmpdir(), 'masumi-export-handler-test-'));
	});

	afterEach(async () => {
		await rm(testDirectory, { recursive: true, force: true });
	});

	async function createArtifact(
		content: Buffer,
		overrides: Partial<StagedReportArtifact> = {},
	): Promise<{ artifact: StagedReportArtifact; cleanup: jest.Mock<() => Promise<void>> }> {
		const filePath = join(testDirectory, 'transactions.csv');
		await writeFile(filePath, content);
		const cleanup = jest.fn(async () => undefined);
		return {
			artifact: {
				filePath,
				filename: 'transactions.csv',
				contentType: REPORT_CSV_CONTENT_TYPE,
				contentLength: content.length,
				cleanup,
				...overrides,
			},
			cleanup,
		};
	}

	it('streams exact bytes with download headers, then cleans once', async () => {
		const content = Buffer.from('id,amount\r\n1,42\r\n');
		const { artifact, cleanup } = await createArtifact(content);
		const response = new TestResponse();
		const logger = createLogger();

		await executeSuccess(artifact, response, logger);

		expect(response.statusCode).toBe(200);
		expect(response.headers.get('content-type')).toBe(REPORT_CSV_CONTENT_TYPE);
		expect(response.headers.get('content-disposition')).toBe(
			`attachment; filename="transactions.csv"; filename*=UTF-8''transactions.csv`,
		);
		expect(response.headers.get('content-length')).toBe(String(content.length));
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.bytes).toEqual(content);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('declares ZIP downloads with an RFC 5987 filename', async () => {
		const content = Buffer.from('zip bytes');
		const { artifact, cleanup } = await createArtifact(content, {
			filename: 'report 2026.zip',
			contentType: REPORT_ZIP_CONTENT_TYPE,
		});
		const response = new TestResponse();

		await executeSuccess(artifact, response, createLogger());

		expect(response.headers.get('content-type')).toBe(REPORT_ZIP_CONTENT_TYPE);
		expect(response.headers.get('content-disposition')).toBe(
			`attachment; filename="report 2026.zip"; filename*=UTF-8''report%202026.zip`,
		);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('cleans once when opening the staged file fails', async () => {
		const { artifact, cleanup } = await createArtifact(Buffer.from('unused'), {
			filePath: join(testDirectory, 'missing.csv'),
		});
		const logger = createLogger();

		await executeSuccess(artifact, new TestResponse(), logger);

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith('Report export stream failed', {
			error: expect.objectContaining({ code: 'ENOENT' }),
		});
	});

	it('cleans once when the client disconnects during streaming', async () => {
		const { artifact, cleanup } = await createArtifact(Buffer.alloc(128 * 1024, 7));
		const logger = createLogger();

		await executeSuccess(artifact, new TestResponse(true), logger);

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith('Report export stream failed', {
			error: expect.objectContaining({ code: 'ERR_STREAM_PREMATURE_CLOSE' }),
		});
	});

	it('keeps HTTP errors as JSON and does not set attachment headers', async () => {
		const response = new TestResponse();
		await executeError(
			createHttpError(429, 'Report limit reached', { headers: { 'Retry-After': '30' } }),
			response,
			createLogger(),
		);

		expect(response.statusCode).toBe(429);
		expect(response.jsonBody).toEqual({
			status: 'error',
			error: { message: 'Report limit reached' },
		});
		expect(response.headers.get('retry-after')).toBe('30');
		expect(response.headers.has('content-disposition')).toBe(false);
		expect(response.headers.has('content-length')).toBe(false);
	});

	it('redacts sensitive input in the existing server error log path', async () => {
		const response = new TestResponse();
		const logger = createLogger();
		await executeError(new Error('internal failure'), response, logger, {
			mnemonic: 'secret words',
			nested: { apiKey: 'secret key', safe: 'visible' },
		});

		expect(response.statusCode).toBe(500);
		expect(response.headers.has('content-disposition')).toBe(false);
		expect(logger.error).toHaveBeenCalledWith(
			'Server side error',
			expect.objectContaining({
				url: '/api/v1/reports/transactions.csv',
				payload: {
					mnemonic: '[REDACTED]',
					nested: { apiKey: '[REDACTED]', safe: 'visible' },
				},
			}),
		);
	});

	it('keeps HttpExistsError conflict details in the existing JSON envelope', async () => {
		const response = new TestResponse();
		const logger = createLogger();

		await executeError(
			new HttpExistsError('Report already exists', 'report-1', {
				id: 'report-1',
				name: 'Existing report',
			}),
			response,
			logger,
		);

		expect(response.statusCode).toBe(409);
		expect(response.jsonBody).toEqual({
			status: 'error',
			error: { message: 'Report already exists' },
			id: 'report-1',
			object: { id: 'report-1', name: 'Existing report' },
		});
		expect(response.headers.has('content-disposition')).toBe(false);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it.each(['bad\r\nInjected: value.csv', '../report.csv', 'folder/report.csv', '', '\ud800.csv'])(
		'rejects unsafe filename %p before response headers',
		async (filename) => {
			const content = Buffer.from('unused');
			const { artifact, cleanup } = await createArtifact(content, { filename });
			const response = new TestResponse();

			await executeSuccess(artifact, response, createLogger());

			expect(response.statusCode).toBe(500);
			expect(response.jsonBody).toEqual({
				status: 'error',
				error: { message: expect.any(String) },
			});
			expect(response.headers.has('content-disposition')).toBe(false);
			expect(response.headers.has('content-type')).toBe(false);
			expect(cleanup).toHaveBeenCalledTimes(1);
		},
	);

	it('logs one cleanup failure after rejecting an invalid staged artifact', async () => {
		const cleanupError = new Error('cleanup failed');
		const { artifact, cleanup } = await createArtifact(Buffer.from('unused'), {
			filename: 'bad\r\nfilename.csv',
		});
		cleanup.mockRejectedValue(cleanupError);
		const response = new TestResponse();
		const logger = createLogger();

		await executeSuccess(artifact, response, logger);

		expect(response.statusCode).toBe(500);
		expect(response.headers.has('content-disposition')).toBe(false);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith('Report export cleanup failed', { error: cleanupError });
	});

	it('cleans once when artifact property access throws during validation', async () => {
		const cleanup = jest.fn(async () => undefined);
		const validationError = new Error('filename getter failed');
		const artifact: Record<string, unknown> = {
			filePath: join(testDirectory, 'unused.csv'),
			contentType: REPORT_CSV_CONTENT_TYPE,
			contentLength: 0,
			cleanup,
		};
		Object.defineProperty(artifact, 'filename', {
			enumerable: true,
			get: () => {
				throw validationError;
			},
		});
		const response = new TestResponse();

		await executeSuccess(artifact, response, createLogger());

		expect(response.statusCode).toBe(500);
		expect(response.headers.has('content-disposition')).toBe(false);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('requires read authentication on the export endpoint factory', async () => {
		const handler = jest.fn(async () => (await createArtifact(Buffer.from('unused'))).artifact);
		const endpoint = readAuthenticatedReportExportEndpointFactory.build({
			method: 'get',
			input: z.object({}),
			output: reportExportArtifactPassThroughSchema,
			handler,
		});
		const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

		try {
			const { responseMock } = await testEndpoint({
				endpoint,
				requestProps: { method: 'GET', headers: {} },
			});

			expect(responseMock.statusCode).toBe(401);
			expect(responseMock._getJSONData()).toEqual({
				status: 'error',
				error: { message: 'Unauthorized, no authentication token provided' },
			});
			expect(responseMock.getHeader('content-disposition')).toBeUndefined();
			expect(handler).not.toHaveBeenCalled();
		} finally {
			randomSpy.mockRestore();
		}
	});
});

describe('report export header helpers', () => {
	it('encodes Unicode without allowing raw non-ASCII header bytes', () => {
		expect(createAttachmentHeader('résumé.csv')).toBe(
			`attachment; filename="r_sum_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`,
		);
	});

	it('accepts the two staged artifact content types', () => {
		for (const contentType of [REPORT_CSV_CONTENT_TYPE, REPORT_ZIP_CONTENT_TYPE]) {
			expect(
				reportExportArtifactSchema.safeParse({
					filePath: '/private/tmp/report',
					filename: 'report.csv',
					contentType,
					contentLength: 0,
					cleanup: async () => undefined,
				}).success,
			).toBe(true);
		}
	});
});
