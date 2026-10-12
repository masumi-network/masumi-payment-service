import { format } from 'winston';
import { logJsonReplacer } from './log-json-replacer';

const MESSAGE = Symbol.for('message');

function renderLine(meta: object): Record<string, unknown> {
	const jsonFormat = format.json({ replacer: logJsonReplacer });
	const info = jsonFormat.transform({ level: 'error', message: 'boom', ...meta }, jsonFormat.options);
	if (!info || typeof info === 'boolean') throw new Error('format dropped the line');
	return JSON.parse((info as unknown as Record<symbol, string>)[MESSAGE]) as Record<string, unknown>;
}

describe('logJsonReplacer', () => {
	it('keeps the message and stack of an error passed as meta', () => {
		const line = renderLine({ error: new Error('pool timeout') });
		const error = line.error as Record<string, unknown>;
		expect(error.name).toBe('Error');
		expect(error.message).toBe('pool timeout');
		expect(typeof error.stack).toBe('string');
	});

	it('keeps enumerable extras such as a Prisma code next to the message', () => {
		const prismaLike = Object.assign(new Error('Transaction API error'), { code: 'P2028', clientVersion: '7.8.0' });
		const error = renderLine({ error: prismaLike }).error as Record<string, unknown>;
		expect(error).toMatchObject({ code: 'P2028', clientVersion: '7.8.0', message: 'Transaction API error' });
	});

	it('serializes nested errors and their cause', () => {
		// Defined the way the native `new Error(message, { cause })` does: own, not enumerable.
		const outer = Object.defineProperty(new Error('outer'), 'cause', { value: new Error('connect ECONNREFUSED') });
		const line = renderLine({ details: { error: outer } });
		const error = (line.details as Record<string, Record<string, unknown>>).error;
		expect(error.message).toBe('outer');
		expect((error.cause as Record<string, unknown>).message).toBe('connect ECONNREFUSED');
	});

	it('still writes bigint as a string', () => {
		expect(renderLine({ amount: 10n ** 20n }).amount).toBe('100000000000000000000');
	});
});
