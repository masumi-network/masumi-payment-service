import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Network } from '@/generated/prisma/client';
import { DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH } from '@/lib/hydra/hydra/commit-draft-validation';
import { DEFAULT_HYDRA_HEAD_SCRIPT_HASH } from '@/lib/hydra/hydra/head-init-validation';
import {
	DEFAULT_EXPECTED_HYDRA_VERSION,
	DEFAULT_EXPECTED_SCRIPT_CATALOGUE_HASH,
	DEFAULT_PREPROD_LEDGER_PARAMS_HASH,
	expectedHostCapabilitiesForNetwork,
} from './compatibility';
import { REVIEWED_HYDRA_RELEASE } from './reviewed-catalogue';

describe('expectedHostCapabilitiesForNetwork', () => {
	it('uses the reviewed version, catalogue and committed preprod ledger fingerprint', () => {
		expect(expectedHostCapabilitiesForNetwork(Network.Preprod, {})).toEqual({
			network: 'preprod',
			hydraVersion: DEFAULT_EXPECTED_HYDRA_VERSION,
			scriptCatalogueHash: DEFAULT_EXPECTED_SCRIPT_CATALOGUE_HASH,
			ledgerParamsHash: DEFAULT_PREPROD_LEDGER_PARAMS_HASH,
		});
	});

	it('publishes the hash of the reviewed catalogue in the release record', () => {
		const digest = createHash('sha256').update(JSON.stringify(REVIEWED_HYDRA_RELEASE.catalogue)).digest('hex');
		expect(REVIEWED_HYDRA_RELEASE.catalogueHash).toBe(`sha256:${digest}`);
		expect(REVIEWED_HYDRA_RELEASE.version).toBe(DEFAULT_EXPECTED_HYDRA_VERSION);
		const dockerfile = readFileSync('packages/hydra-host/Dockerfile', 'utf8');
		expect(dockerfile).toContain(`ARG HYDRA_IMAGE_DIGEST=${REVIEWED_HYDRA_RELEASE.upstreamImageDigest}`);
		expect(REVIEWED_HYDRA_RELEASE.catalogue.headScriptHash).toBe(DEFAULT_HYDRA_HEAD_SCRIPT_HASH);
		expect(REVIEWED_HYDRA_RELEASE.catalogue.depositScriptHash).toBe(DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH);
	});

	it('requires an independently configured mainnet ledger fingerprint', () => {
		expect(() => expectedHostCapabilitiesForNetwork(Network.Mainnet, {})).toThrow(
			/HYDRA_EXPECTED_LEDGER_PARAMS_HASH_MAINNET/,
		);
	});

	it('rejects a catalogue hash copied from an unreviewed Host', () => {
		expect(() =>
			expectedHostCapabilitiesForNetwork(Network.Preprod, {
				HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH: `sha256:${'a'.repeat(64)}`,
			}),
		).toThrow(/differs from the reviewed catalogue/);
	});

	it('rejects an unreviewed Hydra version', () => {
		expect(() =>
			expectedHostCapabilitiesForNetwork(Network.Preprod, {
				HYDRA_EXPECTED_VERSION: '2.4.2-deadbeef',
			}),
		).toThrow(/not the reviewed Hydra binary/);
	});

	it('says where the ledger params fingerprint comes from', () => {
		expect(() => expectedHostCapabilitiesForNetwork(Network.Mainnet, {})).toThrow(
			/packages\/hydra-host\/params\/mainnet\.json/,
		);
	});
});
