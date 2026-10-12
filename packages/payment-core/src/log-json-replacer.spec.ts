import { format } from 'winston';
import { logJsonFormatOptions } from './log-json-replacer';

const MESSAGE = Symbol.for('message');

function renderLine(meta: object): Record<string, unknown> {
	const jsonFormat = format.json(logJsonFormatOptions);
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

	it('writes an error that causes itself instead of overflowing the stack', () => {
		const looping = new Error('loops');
		Object.defineProperty(looping, 'cause', { value: looping });
		const selfReferencing = Object.assign(new Error('self'), { self: undefined as Error | undefined });
		selfReferencing.self = selfReferencing;
		const first = new Error('first');
		const second = new Error('second');
		Object.defineProperty(first, 'cause', { value: second });
		Object.defineProperty(second, 'cause', { value: first });

		for (const error of [looping, selfReferencing, first]) {
			expect((renderLine({ error }).error as Record<string, unknown>).message).toBe(error.message);
		}
	});

	it('writes an error with several links back to itself once', () => {
		const error = Object.assign(new Error('branching'), { self: undefined as Error | undefined });
		error.self = error;
		Object.defineProperty(error, 'cause', { value: error });
		const line = renderLine({ error });
		const written = line.error as Record<string, unknown>;
		expect(written).toMatchObject({ message: 'branching', self: '[Circular]', cause: '[Circular]' });
		expect(JSON.stringify(line).length).toBeLessThan(10_000);
	});

	it('does not throw when an error getter throws', () => {
		const error = new Error('hostile');
		Object.defineProperty(error, 'stack', {
			get: () => {
				throw new Error('no stack for you');
			},
		});
		expect(renderLine({ error }).error).toBe('[Unserializable Error]');
	});

	it('still writes bigint as a string', () => {
		expect(renderLine({ amount: 10n ** 20n }).amount).toBe('100000000000000000000');
	});
});
