import { describe, expect, it, jest } from '@jest/globals';
import { ROBOTS_TXT_ALLOW_ALL, robotsNoindex, serveRobotsTxt } from './index';

describe('robotsNoindex', () => {
	it('sets the noindex header and continues the chain', () => {
		const setHeader = jest.fn();
		const next = jest.fn();

		robotsNoindex({} as never, { setHeader } as never, next);

		expect(setHeader).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow');
		expect(next).toHaveBeenCalledTimes(1);
	});
});

describe('serveRobotsTxt', () => {
	it('serves the allow-all robots policy as plain text', () => {
		const res = { type: jest.fn(), send: jest.fn() };
		res.type.mockReturnValue(res as never);

		serveRobotsTxt({} as never, res as never);

		expect(res.type).toHaveBeenCalledWith('text/plain');
		expect(res.send).toHaveBeenCalledWith(ROBOTS_TXT_ALLOW_ALL);
	});

	it('never disallows crawling, because a blocked crawler cannot see noindex', () => {
		expect(ROBOTS_TXT_ALLOW_ALL).not.toMatch(/disallow/i);
		expect(ROBOTS_TXT_ALLOW_ALL).toContain('User-agent: *');
	});
});
