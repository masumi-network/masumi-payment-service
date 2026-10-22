import { describe, expect, it, jest } from '@jest/globals';
import {
	attemptFailure,
	attemptRedemption,
	isPrivateOrSpecialAddress,
	resolveExchangeTarget,
	type ExchangeClientDeps,
	type RedemptionBody,
} from './exchange-client';

/** What most of these tests care about: it worked, or this is the error an operator sees. */
async function postRedemption(...args: Parameters<typeof attemptRedemption>): Promise<void> {
	const outcome = await attemptRedemption(...args);
	if (outcome.kind !== 'accepted') throw attemptFailure(outcome);
}

const redemption: RedemptionBody = {
	nonce: 'invite-nonce',
	redeemer: {
		walletAddress: 'addr_test1_redeemer',
		hydraVerificationKey: 'hydra-vk',
		cardanoVerificationKey: 'cardano-vk',
		advertise: 'hydra.internal:5001',
		exchangeUrl: 'http://redeemer.internal:4001/exchange',
	},
	signature: { signature: 'signature', key: 'key' },
};

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

function successfulDeps(resolve = PUBLIC_DNS) {
	const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue({ status: 200, detail: '' });
	return { deps: { resolve, send }, send };
}

describe('Hydra invite exchange transport security', () => {
	it('does not send a redemption to HTTP without explicit operator consent', async () => {
		const { deps, send } = successfulDeps();
		await expect(
			postRedemption(
				'http://issuer.example:4000/exchange',
				redemption,
				{ allowInsecureHttp: false, allowPrivateNetwork: false },
				deps,
			),
		).rejects.toThrow(/allowInsecureExchangeHttp/);
		expect(send).not.toHaveBeenCalled();
	});

	it('allows HTTP after explicit operator consent', async () => {
		const { deps, send } = successfulDeps();
		await expect(
			postRedemption(
				'http://issuer.example:4000/exchange',
				redemption,
				{ allowInsecureHttp: true, allowPrivateNetwork: false },
				deps,
			),
		).resolves.toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('allows HTTPS without the insecure transport opt-in', async () => {
		const { deps, send } = successfulDeps();
		await expect(
			postRedemption(
				'https://issuer.example/exchange',
				redemption,
				{ allowInsecureHttp: false, allowPrivateNetwork: false },
				deps,
			),
		).resolves.toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.2', '::1', 'fc00::1', 'fe80::1'])(
		'classifies %s as private or special-use',
		(address) => expect(isPrivateOrSpecialAddress(address)).toBe(true),
	);

	it('rejects a hostname resolving to private infrastructure by default', async () => {
		await expect(
			resolveExchangeTarget(
				'https://issuer.example/exchange',
				{ allowInsecureHttp: false, allowPrivateNetwork: false },
				async () => [{ address: '169.254.169.254', family: 4 }],
			),
		).rejects.toThrow(/allowPrivateExchangeNetwork/);
	});

	it('rejects mixed public/private DNS answers rather than selecting the public one', async () => {
		await expect(
			resolveExchangeTarget(
				'https://issuer.example/exchange',
				{ allowInsecureHttp: false, allowPrivateNetwork: false },
				async () => [
					{ address: '93.184.216.34', family: 4 },
					{ address: '10.0.0.5', family: 4 },
				],
			),
		).rejects.toThrow(/private or special-use/);
	});

	it('allows a private secured network only after its separate opt-in', async () => {
		const { deps, send } = successfulDeps(async () => [{ address: '10.0.0.5', family: 4 }]);
		await expect(
			postRedemption(
				'http://issuer.internal:4000/exchange',
				redemption,
				{ allowInsecureHttp: true, allowPrivateNetwork: true },
				deps,
			),
		).resolves.toBeUndefined();
		expect(send.mock.calls[0][1]).toMatchObject({ address: '10.0.0.5', isPrivate: true });
	});

	it('connects to the checked DNS address rather than resolving again in the sender', async () => {
		const { deps, send } = successfulDeps();
		await postRedemption(
			'https://issuer.example/exchange',
			redemption,
			{ allowInsecureHttp: false, allowPrivateNetwork: false },
			deps,
		);
		expect(send.mock.calls[0][1]).toEqual({ address: '93.184.216.34', family: 4, isPrivate: false });
	});
});

describe('redemption retry on a busy Host', () => {
	const transport = { allowInsecureHttp: false, allowPrivateNetwork: false };
	const sleep = jest.fn(async (_ms: number) => undefined);
	const busy = { status: 503, detail: '{"error":"exchange is busy"}' };

	it('retries a 503 and succeeds once the Host has room', async () => {
		const send = jest
			.fn<NonNullable<ExchangeClientDeps['send']>>()
			.mockResolvedValueOnce(busy)
			.mockResolvedValueOnce({ status: 200, detail: '' });
		await expect(
			postRedemption('https://issuer.example/exchange', redemption, transport, { resolve: PUBLIC_DNS, send, sleep }),
		).resolves.toBeUndefined();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('gives up after four 503s, waiting longer than the Host body deadline', async () => {
		sleep.mockClear();
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue(busy);
		await expect(
			postRedemption('https://issuer.example/exchange', redemption, transport, { resolve: PUBLIC_DNS, send, sleep }),
		).rejects.toThrow(/refused the redemption \(503\)/);
		expect(send).toHaveBeenCalledTimes(4);
		const waitedMs = sleep.mock.calls.reduce((total, [ms]) => total + ms, 0);
		expect(waitedMs).toBeGreaterThan(5_000);
	});

	it.each([409, 429])('does not retry a %s', async (status) => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue({ status, detail: '' });
		await expect(
			postRedemption('https://issuer.example/exchange', redemption, transport, { resolve: PUBLIC_DNS, send, sleep }),
		).rejects.toThrow(new RegExp(`\\(${status}\\)`));
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('does not retry a transport failure, which may have spent the nonce', async () => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockRejectedValue(new Error('socket hang up'));
		await expect(
			postRedemption('https://issuer.example/exchange', redemption, transport, { resolve: PUBLIC_DNS, send, sleep }),
		).rejects.toThrow(/could not reach/);
		expect(send).toHaveBeenCalledTimes(1);
	});
});

/**
 * What a redeemer can conclude from an attempt. The distinctions are the whole
 * point: only a redemption that provably never reached the Host, or that the
 * Host answered, lets the caller discard its record. A timeout or a reset may
 * have landed and spent the nonce.
 */
describe('attemptRedemption outcomes', () => {
	const transport = { allowInsecureHttp: false, allowPrivateNetwork: false };
	const sleep = jest.fn(async (_ms: number) => undefined);
	const attempt = (send: NonNullable<ExchangeClientDeps['send']>, resolve = PUBLIC_DNS) =>
		attemptRedemption('https://issuer.example/exchange', redemption, transport, { resolve, send, sleep });
	const failingWith = (message: string, code?: string) =>
		jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockRejectedValue(Object.assign(new Error(message), { code }));

	it('reports a 2xx as accepted', async () => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue({ status: 200, detail: '' });

		await expect(attempt(send)).resolves.toEqual({ kind: 'accepted' });
	});

	it('reads the redeemed-by-other code from a 409', async () => {
		const detail = JSON.stringify({ error: 'invite already redeemed', code: 'redeemed-by-other' });
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue({ status: 409, detail });

		await expect(attempt(send)).resolves.toEqual({
			kind: 'answered',
			status: 409,
			code: 'redeemed-by-other',
			fromHost: true,
			detail,
		});
	});

	it.each([
		['an older Host that sends no code', '{"error":"invite already redeemed"}'],
		['a body that is not JSON', 'upstream gateway error'],
		['an empty body', ''],
		['a code that is not a string', '{"code":5}'],
	])('reads no code from %s', async (_label, detail) => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue({ status: 409, detail });

		await expect(attempt(send)).resolves.toMatchObject({ kind: 'answered', status: 409, code: null });
	});

	it.each([
		['the Host', '{"error":"exchange is busy"}', true],
		['a gateway page', '<html>503 Service Unavailable</html>', false],
		['a JSON body with no error', '{"message":"unavailable"}', false],
	])('tells a refusal from %s apart', async (_label, detail, fromHost) => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue({ status: 502, detail });

		await expect(attempt(send)).resolves.toMatchObject({ kind: 'answered', status: 502, fromHost });
	});

	it.each([400, 401, 404, 410, 413, 429, 500, 502, 504])('reports a %s as answered', async (status) => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>().mockResolvedValue({ status, detail: '' });

		await expect(attempt(send)).resolves.toMatchObject({ kind: 'answered', status });
	});

	it('reports a 503 that outlasts the retries as answered', async () => {
		const send = jest
			.fn<NonNullable<ExchangeClientDeps['send']>>()
			.mockResolvedValue({ status: 503, detail: '{"error":"exchange is busy"}' });

		await expect(attempt(send)).resolves.toMatchObject({ kind: 'answered', status: 503 });
		expect(send).toHaveBeenCalledTimes(4);
	});

	// Regression: a gateway 503 may follow a stored redemption, so a discardable
	// answer to the resend must not stand for the first send.
	it.each([
		['the Host refuses as busy', { status: 503, detail: '{"error":"exchange is busy"}' }],
		['the Host masks the nonce', { status: 404, detail: '{"error":"no such invite"}' }],
		['the Host is over budget', { status: 429, detail: '{"error":"too many requests"}' }],
	])('reports a gateway 503 then %s as unknown', async (_label, later) => {
		const send = jest
			.fn<NonNullable<ExchangeClientDeps['send']>>()
			.mockResolvedValueOnce({ status: 503, detail: '<html>503</html>' })
			.mockResolvedValue(later);

		await expect(attempt(send)).resolves.toMatchObject({ kind: 'unknown' });
	});

	it('reports a gateway 503 then a refused connection as unknown', async () => {
		const send = jest
			.fn<NonNullable<ExchangeClientDeps['send']>>()
			.mockResolvedValueOnce({ status: 503, detail: '<html>503</html>' })
			.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

		await expect(attempt(send)).resolves.toMatchObject({ kind: 'unknown' });
	});

	it('reports a gateway 503 then a replayed acknowledgement as accepted', async () => {
		const send = jest
			.fn<NonNullable<ExchangeClientDeps['send']>>()
			.mockResolvedValueOnce({ status: 503, detail: '<html>503</html>' })
			.mockResolvedValue({ status: 200, detail: '{"redeemed":true}' });

		await expect(attempt(send)).resolves.toEqual({ kind: 'accepted' });
	});

	it('reports a refused transport opt-in as never sent', async () => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>();

		const outcome = await attemptRedemption('http://issuer.example/exchange', redemption, transport, {
			resolve: PUBLIC_DNS,
			send,
			sleep,
		});

		expect(outcome).toMatchObject({ kind: 'not-sent', error: { status: 400 } });
		expect(send).not.toHaveBeenCalled();
	});

	it('reports a name that does not resolve as never sent', async () => {
		const send = jest.fn<NonNullable<ExchangeClientDeps['send']>>();
		const unresolved = async (): Promise<Array<{ address: string; family: number }>> => {
			throw new Error('getaddrinfo ENOTFOUND issuer.example');
		};

		const outcome = await attempt(send, unresolved);

		expect(outcome).toMatchObject({ kind: 'not-sent', error: { status: 502 } });
		expect(send).not.toHaveBeenCalled();
	});

	it.each([
		['ECONNREFUSED', 'connect ECONNREFUSED 93.184.216.34:443'],
		['ENOTFOUND', 'getaddrinfo ENOTFOUND issuer.example'],
		['EHOSTUNREACH', 'connect EHOSTUNREACH'],
		['ENETUNREACH', 'connect ENETUNREACH'],
		['CERT_HAS_EXPIRED', 'certificate has expired'],
		['ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname/IP does not match certificate'],
	])('reports %s as never sent, because nothing reached the Host', async (code, message) => {
		const outcome = await attempt(failingWith(message, code));

		expect(outcome).toMatchObject({ kind: 'not-sent' });
	});

	it.each([
		['ECONNRESET', 'socket hang up'],
		['ETIMEDOUT', 'connect ETIMEDOUT'],
		['EPIPE', 'write EPIPE'],
		[undefined, 'request timed out'],
		[undefined, 'counterparty response exceeded the size limit'],
	])('reports %s (%s) as unknown, because it may have landed', async (code, message) => {
		const outcome = await attempt(failingWith(message, code));

		expect(outcome).toMatchObject({ kind: 'unknown', reason: message });
	});
});

// Teredo and 6to4 addresses embed an IPv4 address, so an unfiltered one reaches
// a blocked range under a different family.
describe('isPrivateOrSpecialAddress — IPv4-in-IPv6 transition ranges', () => {
	it('rejects 6to4 and Teredo', () => {
		expect(isPrivateOrSpecialAddress('2002:7f00:1::1')).toBe(true);
		expect(isPrivateOrSpecialAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(true);
	});

	it('still rejects the mapped and loopback forms', () => {
		expect(isPrivateOrSpecialAddress('::ffff:127.0.0.1')).toBe(true);
		expect(isPrivateOrSpecialAddress('::1')).toBe(true);
		expect(isPrivateOrSpecialAddress('169.254.169.254')).toBe(true);
	});

	it('still allows an ordinary public address', () => {
		expect(isPrivateOrSpecialAddress('2606:4700:4700::1111')).toBe(false);
		expect(isPrivateOrSpecialAddress('1.1.1.1')).toBe(false);
	});
});
