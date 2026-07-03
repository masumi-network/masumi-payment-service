import { Network } from '@/generated/prisma/client';
import { DEFAULTS } from '@masumi/payment-core/config';

/**
 * Whether a Web3CardanoV2 payment source is on the CURRENT on-chain contract.
 *
 * The reliable signal is the registry `policyId`: it is derived from
 * `getRegistryScriptV2(network)` — network-only, INDEPENDENT of admin wallets —
 * so it bumps in lockstep with the compiled contract version (e.g. the Aiken
 * v1.1.23 + CIP-30 upgrade, `7890b485… -> 67ab0c92…`) and is identical for
 * default and custom sources of a given version.
 *
 *  - `outdated_contract` — policyId differs from the current default: the source
 *    was minted against a RETIRED contract. Its agents are invisible to the
 *    current registry policy and its baked-in payment address is stale.
 *  - `custom_address`   — policyId matches (current version) but the payment
 *    address is not the seed default: a legitimate custom (non-default
 *    admin-wallet) source. Not a problem.
 *  - `in_sync`          — matches the current default contract, or no policyId
 *    to compare (never false-flags).
 */
export type V2SourceSyncStatus = 'in_sync' | 'outdated_contract' | 'custom_address';

export function defaultV2ContractParams(
	network: Network,
): { smartContractAddress: string; policyId: string; adminWallets: string[] } | null {
	if (network === Network.Preprod) {
		return {
			smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD,
			policyId: DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD,
			adminWallets: [DEFAULTS.ADMIN_WALLET1_PREPROD, DEFAULTS.ADMIN_WALLET2_PREPROD, DEFAULTS.ADMIN_WALLET3_PREPROD],
		};
	}
	if (network === Network.Mainnet) {
		return {
			smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_MAINNET,
			policyId: DEFAULTS.REGISTRY_POLICY_ID_V2_MAINNET,
			adminWallets: [DEFAULTS.ADMIN_WALLET1_MAINNET, DEFAULTS.ADMIN_WALLET2_MAINNET, DEFAULTS.ADMIN_WALLET3_MAINNET],
		};
	}
	return null;
}

export function classifyV2SourceSync(source: {
	network: Network;
	policyId: string | null;
	smartContractAddress: string;
}): V2SourceSyncStatus {
	const expected = defaultV2ContractParams(source.network);
	if (expected === null) {
		return 'in_sync';
	}
	if (source.policyId !== null && source.policyId !== expected.policyId) {
		return 'outdated_contract';
	}
	if (source.smartContractAddress !== expected.smartContractAddress) {
		return 'custom_address';
	}
	return 'in_sync';
}
