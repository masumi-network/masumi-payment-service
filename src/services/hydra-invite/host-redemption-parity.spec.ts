/**
 * The Hydra Host rebuilds the redemption payload itself, because it builds
 * standalone and cannot import this service. If the two builders drift, every
 * honest redemption is refused at the Host with 401. These tests pin them to
 * the same bytes.
 */

import { describe, expect, it } from '@jest/globals';
import { MeshWallet } from '@meshsdk/core';
import {
	HYDRA_REDEMPTION_PAYLOAD_VERSION as HOST_REDEMPTION_PAYLOAD_VERSION,
	hashRedemptionPayload as hostHashRedemptionPayload,
	redemptionNetwork,
	verifyRedemptionSignature,
} from '@masumi/hydra-host/registry/redemption-signature';
import { Network } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';
import { HYDRA_REDEMPTION_PAYLOAD_VERSION } from './invite-payload';
import { hashRedemptionPayload, signHydraRedemption } from './invite-signing';

const MATERIAL = {
	hydraVerificationKey: `5820${'11'.repeat(32)}`,
	cardanoVerificationKey: `5820${'22'.repeat(32)}`,
	advertise: 'them.example.com:5101',
	exchangeUrl: 'https://them.example.com/exchange',
};

describe('host redemption payload parity', () => {
	it('uses the same payload version', () => {
		expect(HOST_REDEMPTION_PAYLOAD_VERSION).toBe(HYDRA_REDEMPTION_PAYLOAD_VERSION);
	});

	it('maps the host network config to the Network value the service signs', () => {
		expect(redemptionNetwork('preprod')).toBe(Network.Preprod);
		expect(redemptionNetwork('mainnet')).toBe(Network.Mainnet);
	});

	it('hashes the same bytes as the service', () => {
		const walletAddress = 'addr_test1qexample';
		const nonce = 'nonce-parity01';
		for (const network of [Network.Preprod, Network.Mainnet]) {
			expect(hostHashRedemptionPayload(nonce, network, { walletAddress, ...MATERIAL })).toBe(
				hashRedemptionPayload({ nonce, network, redeemerWalletAddress: walletAddress, ...MATERIAL }),
			);
		}
	});

	it('accepts a redemption the service signed', async () => {
		const words = MeshWallet.brew() as string[];
		const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
		await wallet.init();
		const walletAddress = await wallet.getChangeAddress();
		const nonce = 'nonce-parity02';

		const signature = await signHydraRedemption(
			{ nonce, network: Network.Preprod, redeemerWalletAddress: walletAddress, ...MATERIAL },
			{ encryptedMnemonic: encrypt(words.join(' ')), walletAddress, network: Network.Preprod },
		);

		await expect(
			verifyRedemptionSignature(nonce, redemptionNetwork('preprod'), { walletAddress, ...MATERIAL }, signature),
		).resolves.toBe(true);
	});
});
