import { Network } from '@/generated/prisma/client';
import type { ExpectedHostCapabilities } from './placement';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Hydra release reviewed by this service. Override only as part of an upgrade. */
export const DEFAULT_EXPECTED_HYDRA_VERSION = '2.3.0';

/**
 * Hash of the reviewed preprod file committed at
 * packages/hydra-host/params/preprod.json.
 */
export const DEFAULT_PREPROD_LEDGER_PARAMS_HASH =
	'sha256:ab9c93abfd5194a25e07ff9e673d727445515bdb728a9d2278b5aac8cffb0c18';

export class HostCompatibilityConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostCompatibilityConfigError';
	}
}

function requiredSha256(value: string | undefined, name: string): string {
	const normalized = value?.trim().toLowerCase() ?? '';
	if (!SHA256_PATTERN.test(normalized)) {
		throw new HostCompatibilityConfigError(`${name} must be set to a sha256:<64 lowercase hex characters> fingerprint`);
	}
	return normalized;
}

/**
 * Independent compatibility manifest for Hydra Host placement.
 *
 * Values come from service configuration and reviewed repository artifacts,
 * never from the Host row or the capabilities response being checked.
 */
export function expectedHostCapabilitiesForNetwork(
	network: Network,
	env: NodeJS.ProcessEnv = process.env,
): ExpectedHostCapabilities {
	const hydraVersion = env.HYDRA_EXPECTED_VERSION?.trim() || DEFAULT_EXPECTED_HYDRA_VERSION;
	if (!VERSION_PATTERN.test(hydraVersion)) {
		throw new HostCompatibilityConfigError('HYDRA_EXPECTED_VERSION must be an exact semantic version');
	}

	const scriptCatalogueHash = requiredSha256(
		env.HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH,
		'HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH',
	);
	const ledgerParamsHash = requiredSha256(
		network === Network.Preprod
			? env.HYDRA_EXPECTED_LEDGER_PARAMS_HASH_PREPROD || DEFAULT_PREPROD_LEDGER_PARAMS_HASH
			: env.HYDRA_EXPECTED_LEDGER_PARAMS_HASH_MAINNET,
		network === Network.Preprod
			? 'HYDRA_EXPECTED_LEDGER_PARAMS_HASH_PREPROD'
			: 'HYDRA_EXPECTED_LEDGER_PARAMS_HASH_MAINNET',
	);

	return {
		network: network.toLowerCase(),
		hydraVersion,
		scriptCatalogueHash,
		ledgerParamsHash,
	};
}
