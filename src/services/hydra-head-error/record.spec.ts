import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraErrorType, HydraHeadStatus, Prisma } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockCreate = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHeadError: { create: mockCreate } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: mockLoggerError, debug: jest.fn() },
}));

let recordHeadError: typeof import('./record').recordHeadError;
let describeErrorForOperator: typeof import('./operator-message').describeErrorForOperator;

beforeAll(async () => {
	({ recordHeadError } = await import('./record'));
	({ describeErrorForOperator } = await import('./operator-message'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockCreate.mockResolvedValue({});
});

// What the driver says carries the invocation, an absolute path on the server and
// a code excerpt. It reached the operator through the head's error list.
const RAW =
	'Invalid `tx.hydraTopup.create()` invocation in\n/Users/dev/masumi/src/services/hydra-topup/execute.ts:204:42\n\n' +
	'  201 await tx.hydraTopup.create({\n  202 data: { committedLovelace: 99999999999999999999n\n\nvalue out of range for type bigint';
const CLIENT_VERSION = '7.8.0';

const prismaErrors: Array<[string, () => Error]> = [
	[
		'known request',
		() => new Prisma.PrismaClientKnownRequestError(RAW, { code: 'P2020', clientVersion: CLIENT_VERSION }),
	],
	['unknown request', () => new Prisma.PrismaClientUnknownRequestError(RAW, { clientVersion: CLIENT_VERSION })],
	['validation', () => new Prisma.PrismaClientValidationError(RAW, { clientVersion: CLIENT_VERSION })],
	['initialization', () => new Prisma.PrismaClientInitializationError(RAW, CLIENT_VERSION, 'P1001')],
	['rust panic', () => new Prisma.PrismaClientRustPanicError(RAW, CLIENT_VERSION)],
];

describe('describeErrorForOperator', () => {
	it.each(prismaErrors)('says only that the database refused when the error is a %s error', (_label, make) => {
		const message = describeErrorForOperator(make());

		expect(message).toContain('the database rejected the write');
		expect(message).not.toContain('/Users/');
		expect(message).not.toContain('hydraTopup');
	});

	it('names the error code when there is one', () => {
		const error = new Prisma.PrismaClientKnownRequestError(RAW, { code: 'P2020', clientVersion: CLIENT_VERSION });

		expect(describeErrorForOperator(error)).toBe('the database rejected the write (P2020)');
	});

	it('keeps the full error for the log', () => {
		const error = new Prisma.PrismaClientKnownRequestError(RAW, { code: 'P2020', clientVersion: CLIENT_VERSION });

		describeErrorForOperator(error);

		expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('database'), { error });
	});

	it('leaves every other error as it was', () => {
		expect(describeErrorForOperator(new Error('node refused the request'))).toBe('node refused the request');
		expect(describeErrorForOperator('plain text')).toBe('plain text');
	});
});

describe('recordHeadError', () => {
	it('stores no server path from a database error', async () => {
		const error = new Prisma.PrismaClientKnownRequestError(RAW, { code: 'P2020', clientVersion: CLIENT_VERSION });

		await expect(
			recordHeadError('head-1', HydraHeadStatus.Open, HydraErrorType.CommandFailed, error, 'Topup'),
		).resolves.toBe(true);

		const stored = mockCreate.mock.calls[0]?.[0]?.data?.errorMessage as string;
		expect(stored).toBe('the database rejected the write (P2020)');
	});

	it('still stores an ordinary error as it is', async () => {
		await recordHeadError('head-1', HydraHeadStatus.Open, HydraErrorType.CommandFailed, new Error('nope'), 'Topup');

		expect(mockCreate.mock.calls[0]?.[0]?.data?.errorMessage).toBe('nope');
	});
});
