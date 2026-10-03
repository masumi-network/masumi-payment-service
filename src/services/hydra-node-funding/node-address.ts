/**
 * The on-chain address of a hydra-node's own Cardano key.
 *
 * A node is provisioned with a fresh Cardano key that holds nothing, and Hydra
 * needs that key to hold funds before a head can be opened: the InitTx consumes
 * a *seed* UTxO at this address to derive the head's unique identifier, and
 * pays its fee from the same place. Without one the node reports
 * `postTxError: NoSeedInput` and the head never leaves Idle.
 *
 * Deliberately not the funding wallet. ADR 0015 §3 keeps the node's
 * infrastructure key separate from the custodial wallet precisely so a
 * compromised host cannot reach escrowed funds — so this address is funded by a
 * transfer, never by sharing a key.
 *
 * Enterprise rather than base: the node never delegates and has no use for a
 * stake credential, and an enterprise address is derivable from the key hash
 * alone — which is all this service stores (`HydraLocalParticipant.cardanoVkey`
 * is the 28-byte blake2b-224 hash, not the key).
 */

import { NetworkId, buildEnterpriseAddress, type Hash28ByteBase16 } from '@meshsdk/core-cst';
import { Network } from '@/generated/prisma/client';
import { HydraProtocolError } from '@/lib/hydra/hydra/errors';

const KEY_HASH_HEX_LENGTH = 56;

function networkIdFor(network: Network): NetworkId {
	return network === Network.Mainnet ? NetworkId.Mainnet : NetworkId.Testnet;
}

/**
 * Bech32 address holding the node's Cardano key hash.
 *
 * The hash is what Hydra puts on chain as the participant identity, so an
 * address derived from it is the one the node will actually spend from — there
 * is no second place the funds could land.
 */
export function nodeCardanoAddress(cardanoVkeyHash: string, network: Network): string {
	const normalized = cardanoVkeyHash.trim().toLowerCase();
	if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== KEY_HASH_HEX_LENGTH) {
		throw new HydraProtocolError(
			`not a 28-byte Cardano key hash: ${JSON.stringify(cardanoVkeyHash)} (${normalized.length / 2} bytes)`,
		);
	}

	try {
		return buildEnterpriseAddress(networkIdFor(network), normalized as Hash28ByteBase16)
			.toAddress()
			.toBech32();
	} catch (error) {
		throw new HydraProtocolError(`could not derive the node address: ${(error as Error).message}`);
	}
}
