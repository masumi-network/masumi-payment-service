/**
 * Who is on the other end of an invite.
 *
 * A wallet address authenticates an invite but does not identify anyone: a
 * signature proves the sender holds that key, not that the key belongs to the
 * organisation the operator meant to open a head with. Registry entries close
 * that gap, because they are the same on-chain identities agents are discovered
 * and paid through.
 *
 * The difference this makes is not cosmetic. `addr_test1qppueqn6…` is a check
 * people click past; "Acme Weather Agent" is one they perform. Approving a
 * redemption is the only human gate in the whole exchange, so it is worth
 * making the gate legible.
 *
 * Best-effort by construction: a wallet holding no registry entry is a fact to
 * show the operator, not an error, and a chain lookup that fails must not block
 * an approval screen.
 */

import { DEFAULTS } from '@masumi/payment-core/config';
import { Network } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { isPlainObject, getOwnValue } from '@masumi/payment-core/object-properties';

/** Cap the work one approval screen can cause; a wallet with hundreds of assets is not the interesting case. */
const MAX_ENTRIES = 12;

export type RegistryIdentity = {
	assetName: string;
	unit: string;
	/** On-chain metadata name, when the entry carries one. */
	name: string | null;
};

export type CounterpartyIdentity = {
	walletAddress: string;
	policyId: string;
	entries: RegistryIdentity[];
	/** Set when the chain could not be consulted, so the UI can say so rather than imply "none". */
	lookupError: string | null;
};

export function registryPolicyIdFor(network: Network): string {
	return network === Network.Mainnet ? DEFAULTS.REGISTRY_POLICY_ID_V2_MAINNET : DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD;
}

/** Pull a display name out of whatever shape the entry's metadata uses. */
function readName(metadata: unknown): string | null {
	if (!isPlainObject(metadata)) {
		return null;
	}
	for (const key of ['name', 'title', 'agentName']) {
		const value = getOwnValue(metadata, key);
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}
	return null;
}

function decodeAssetName(unit: string, policyId: string): string {
	const hex = unit.slice(policyId.length);
	try {
		const decoded = Buffer.from(hex, 'hex').toString('utf8');
		// Registry asset names are printable; anything else is better shown as
		// the hex it actually is than as replacement characters.
		return /^[\x20-\x7e]+$/.test(decoded) ? decoded : hex;
	} catch {
		return hex;
	}
}

/**
 * Registry entries held by a wallet.
 *
 * Two calls: the assets at the address, filtered to the registry policy, then
 * the on-chain metadata of each survivor. The filter runs before the metadata
 * fetch so an unrelated NFT collection costs nothing.
 */
export async function resolveCounterpartyIdentity(
	walletAddress: string,
	network: Network,
	blockfrostApiKey: string,
): Promise<CounterpartyIdentity> {
	const policyId = registryPolicyIdFor(network);
	const identity: CounterpartyIdentity = { walletAddress, policyId, entries: [], lookupError: null };

	let held: Array<{ unit: string; quantity: string }>;
	try {
		const blockfrost = getBlockfrostInstance(network, blockfrostApiKey);
		held = await blockfrost.addressesExtended(walletAddress).then((address) => address.amount);
	} catch (error) {
		// A wallet that has never been used has no address record at all, which
		// Blockfrost reports as 404. That is "no entries", not a failure.
		//
		// Matched on the status code: Blockfrost words this as "has not been
		// found", which does not contain the substring "not found".
		const message = (error as Error).message;
		const status =
			typeof error === 'object' && error !== null ? (error as { status_code?: unknown }).status_code : undefined;
		if (status === 404 || /\b404\b/.test(message)) {
			return identity;
		}
		logger.warn(`hydra: could not read registry entries for ${walletAddress}: ${message}`);
		return { ...identity, lookupError: 'the chain could not be consulted for this wallet' };
	}

	const units = held
		.filter((asset) => asset.unit.startsWith(policyId) && asset.unit !== policyId)
		.slice(0, MAX_ENTRIES);

	const entries = await Promise.all(
		units.map(async (asset) => {
			const base: RegistryIdentity = {
				unit: asset.unit,
				assetName: decodeAssetName(asset.unit, policyId),
				name: null,
			};
			try {
				const blockfrost = getBlockfrostInstance(network, blockfrostApiKey);
				const details = await blockfrost.assetsById(asset.unit);
				return { ...base, name: readName(details.onchain_metadata) };
			} catch {
				// A name we cannot read still leaves a real entry worth showing.
				return base;
			}
		}),
	);

	return { ...identity, entries };
}
