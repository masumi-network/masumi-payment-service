import { describe, expect, it, jest } from '@jest/globals';
import {
	isPrivateOrSpecialAddress,
	postRedemption,
	resolveExchangeTarget,
	type ExchangeClientDeps,
	type RedemptionBody,
} from './exchange-client';

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
