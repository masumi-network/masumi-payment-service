import { describe, expect, it, jest } from '@jest/globals';
import { robotsNoindex, serveRobotsTxt } from './index';

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
	it('serves exactly the allow-all robots policy as plain text', () => {
		const res = { type: jest.fn(), send: jest.fn() };
		res.type.mockReturnValue(res as never);

		serveRobotsTxt({} as never, res as never);

		expect(res.type).toHaveBeenCalledWith('text/plain');
		// The literal is load-bearing: crawling must stay allowed, because a
		// Disallow would hide the noindex header from crawlers.
		expect(res.send).toHaveBeenCalledWith('User-agent: *\nAllow: /\n');
	});
});
