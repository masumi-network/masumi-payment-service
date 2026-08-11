import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import {
	DEFAULT_EXPECTED_HYDRA_VERSION,
	DEFAULT_PREPROD_LEDGER_PARAMS_HASH,
	expectedHostCapabilitiesForNetwork,
} from './compatibility';

const CATALOGUE_HASH = `sha256:${'a'.repeat(64)}`;

describe('expectedHostCapabilitiesForNetwork', () => {
	it('uses the reviewed version and committed preprod ledger fingerprint', () => {
		expect(
			expectedHostCapabilitiesForNetwork(Network.Preprod, {
				HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH: CATALOGUE_HASH,
			}),
		).toEqual({
			network: 'preprod',
			hydraVersion: DEFAULT_EXPECTED_HYDRA_VERSION,
			scriptCatalogueHash: CATALOGUE_HASH,
			ledgerParamsHash: DEFAULT_PREPROD_LEDGER_PARAMS_HASH,
		});
	});

	it('fails closed when no reviewed script catalogue fingerprint is configured', () => {
		expect(() => expectedHostCapabilitiesForNetwork(Network.Preprod, {})).toThrow(
			/HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH/,
		);
	});

	it('requires an independently configured mainnet ledger fingerprint', () => {
		expect(() =>
			expectedHostCapabilitiesForNetwork(Network.Mainnet, {
				HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH: CATALOGUE_HASH,
			}),
		).toThrow(/HYDRA_EXPECTED_LEDGER_PARAMS_HASH_MAINNET/);
	});

	it('rejects malformed expected fingerprints', () => {
		expect(() =>
			expectedHostCapabilitiesForNetwork(Network.Preprod, {
				HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH: 'catalogue-hash',
			}),
		).toThrow(/sha256/);
	});
});
