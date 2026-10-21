import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';

import type { HydraTransaction } from './types';

/**
 * Tokens minted inside the head and not yet burned there.
 *
 * Hydra cannot finalize a head that still holds such a token. The token never
 * entered the head output on L1, so no fanout step that carries it can balance,
 * and the last step has to distribute everything left (Hydra known issues,
 * partial fanout "unburned tokens"). No hydra-node setting forbids L2 minting,
 * and any peer can mint through its own node, so the service cannot prevent
 * it. What it can do is keep its own funds off those UTxOs: an output that
 * carries the token can never leave the head, and spending one beside our
 * funds would carry the token into our change.
 */

/**
 * Add the mint field of each transaction into `tally` (unit → net quantity).
 * A unit whose net reaches zero is dropped, so the keys are exactly the units
 * still outstanding. Returns whether any transaction minted or burned.
 *
 * Only called on transactions the conservation check has already decoded.
 */
export function addL2TransactionMints(tally: Map<string, bigint>, transactions: readonly HydraTransaction[]): boolean {
	let hasMint = false;
	for (const { cborHex } of transactions) {
		const mint = FixedTransaction.from_bytes(Buffer.from(cborHex, 'hex')).body().mint();
		if (!mint) continue;
		hasMint = true;
		const policies = mint.keys();
		for (let policyIndex = 0; policyIndex < policies.len(); policyIndex += 1) {
			const policy = policies.get(policyIndex);
			const groups = mint.get(policy);
			if (!groups) continue;
			for (let groupIndex = 0; groupIndex < groups.len(); groupIndex += 1) {
				const assets = groups.get(groupIndex);
				if (!assets) continue;
				const names = assets.keys();
				for (let assetIndex = 0; assetIndex < names.len(); assetIndex += 1) {
					const name = names.get(assetIndex);
					const quantity = assets.get(name);
					if (!quantity) continue;
					const positive = quantity.as_positive();
					const negative = quantity.as_negative();
					const signed = positive ? BigInt(positive.to_str()) : negative ? -BigInt(negative.to_str()) : 0n;
					// `.name()`, not `.to_hex()`: the latter CBOR-wraps the asset name.
					const unit = `${policy.to_hex()}${Buffer.from(name.name()).toString('hex')}`.toLowerCase();
					const net = (tally.get(unit) ?? 0n) + signed;
					if (net === 0n) tally.delete(unit);
					else tally.set(unit, net);
				}
			}
		}
	}
	return hasMint;
}

/**
 * Whether our own transactions must leave this UTxO unspent: it holds a unit
 * from `units` (lowercase policy id + asset name hex). `units` is undefined
 * while the history replay is still running, so no token can be checked yet,
 * and then any non-ADA asset counts.
 */
export function holdsUnburnedL2Mint(
	utxo: { output: { amount: ReadonlyArray<{ unit: string }> } },
	units: ReadonlySet<string> | undefined,
): boolean {
	return utxo.output.amount.some((asset) => {
		const unit = asset.unit.toLowerCase();
		if (unit === '' || unit === 'lovelace') return false;
		return units === undefined || units.has(unit);
	});
}
