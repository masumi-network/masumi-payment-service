import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createServer } from 'node:http';
import { applyControlPlaneLimits } from './server-limits.js';

describe('control plane drop warnings', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('warns on the first drop at once and counts later drops into one warning a minute', () => {
		jest.useFakeTimers();
		const server = createServer();
		const warn = jest.fn<(message: string) => void>();
		applyControlPlaneLimits(server, 32, warn);

		server.emit('drop');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('dropped 1 connection(s)');

		server.emit('drop');
		server.emit('drop');
		expect(warn).toHaveBeenCalledTimes(1);

		jest.advanceTimersByTime(60_000);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[1][0]).toContain('dropped 2 connection(s)');

		// A quiet minute ends the cycle; the next drop is reported at once again.
		jest.advanceTimersByTime(60_000);
		expect(warn).toHaveBeenCalledTimes(2);
		server.emit('drop');
		expect(warn).toHaveBeenCalledTimes(3);
		expect(warn.mock.calls[2][0]).toContain('dropped 1 connection(s)');
	});
});
