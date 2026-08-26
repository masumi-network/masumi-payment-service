import { describe, expect, it } from '@jest/globals';
import { renderHostLandingPage, renderNotFoundPage, wantsHtmlDocument } from './landing.js';

describe('wantsHtmlDocument', () => {
	it('matches only an explicit html media type', () => {
		// Browsers name text/html outright; API clients and probes must keep
		// receiving JSON they can parse.
		expect(wantsHtmlDocument('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(true);
		expect(wantsHtmlDocument('application/xhtml+xml')).toBe(true);
		expect(wantsHtmlDocument('*/*')).toBe(false);
		expect(wantsHtmlDocument('application/json')).toBe(false);
		expect(wantsHtmlDocument(undefined)).toBe(false);
	});
});

describe('landing pages', () => {
	it('says what the server is and how it is used', () => {
		const page = renderHostLandingPage();
		expect(page).toContain('Masumi Hydra Host');
		expect(page).toContain('Authorization: Bearer');
	});

	it('reveals no operational state', () => {
		// The page is unauthenticated; the network name, slots, nodes and
		// versions stay behind the token-gated capabilities endpoint.
		const page = renderHostLandingPage();
		expect(page).not.toMatch(/slot|node-|version [0-9]|preprod|mainnet|preview/i);
	});

	it('404 page points back to the landing page', () => {
		expect(renderNotFoundPage()).toContain('href="/"');
	});
});
