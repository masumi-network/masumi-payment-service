import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLookup = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('node:dns/promises', () => ({
	lookup: mockLookup,
}));

const { assertWebhookDestinationAllowed, redactWebhookDestination, WebhookDestinationPolicyError } =
	await import('./webhook-destination-policy');

describe('webhook destination policy', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	});

	it('allows public https destinations', async () => {
		await expect(assertWebhookDestinationAllowed('https://example.com/webhook')).resolves.toBeInstanceOf(URL);
		expect(mockLookup).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
	});

	it('allows public http destinations', async () => {
		await expect(assertWebhookDestinationAllowed('http://example.com/webhook')).resolves.toBeInstanceOf(URL);
	});

	it('rejects destinations with userinfo', async () => {
		await expect(assertWebhookDestinationAllowed('https://user:pass@example.com/webhook')).rejects.toBeInstanceOf(
			WebhookDestinationPolicyError,
		);
		expect(mockLookup).not.toHaveBeenCalled();
	});

	it('rejects unresolved destinations', async () => {
		mockLookup.mockRejectedValue(new Error('ENOTFOUND'));

		await expect(assertWebhookDestinationAllowed('https://missing.example/webhook')).rejects.toBeInstanceOf(
			WebhookDestinationPolicyError,
		);
	});

	it('rejects hosts that resolve to blocked private space', async () => {
		mockLookup.mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);

		await expect(assertWebhookDestinationAllowed('https://internal.example/webhook')).rejects.toBeInstanceOf(
			WebhookDestinationPolicyError,
		);
	});

	it.each([
		'http://127.0.0.1/webhook',
		'http://10.0.0.8/webhook',
		'http://172.16.10.5/webhook',
		'http://192.168.1.5/webhook',
		'http://169.254.10.20/webhook',
		'http://100.64.1.10/webhook',
		'http://192.0.2.10/webhook',
		'http://198.18.0.10/webhook',
		'http://198.51.100.10/webhook',
		'http://203.0.113.10/webhook',
		'http://224.0.0.5/webhook',
		'http://0.0.0.0/webhook',
		'http://[::1]/webhook',
		'http://[fc00::1]/webhook',
		'http://[fe80::1]/webhook',
		'http://[ff02::1]/webhook',
		'http://[2001:db8::1]/webhook',
		'http://[::]/webhook',
	])('rejects blocked literal destination %s', async (url) => {
		await expect(assertWebhookDestinationAllowed(url)).rejects.toBeInstanceOf(WebhookDestinationPolicyError);
		expect(mockLookup).not.toHaveBeenCalled();
	});

	it('redacts webhook destinations to scheme, host, and a short hash suffix', () => {
		expect(redactWebhookDestination('https://hooks.slack.com/services/a/b/c?foo=bar')).toMatch(
			/^https:\/\/hooks\.slack\.com#[0-9a-f]{8}$/,
		);
	});
});
