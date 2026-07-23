/**
 * Read THIS node's own in-head balance — how much the local participant's wallet
 * currently holds inside a Hydra head (ADA + native tokens), aggregated per asset.
 *
 * Deliberately scoped to the LOCAL participant's address only: a node can read the
 * full head snapshot, but this surfaces just "my funds in the head", not the
 * counterparty's. It reads the live head snapshot via the head's provider, so it
 * requires an active connection (open head); a head with no live provider returns
 * `connected: false` rather than a stale/guessed balance.
 */
import { prisma } from '@masumi/payment-core/db';
import { getHydraConnectionManager } from './hydra-connection-manager.service';

export interface HydraHeadBalanceAsset {
	/** Empty string for lovelace/ADA; otherwise policyId+assetName hex. */
	unit: string;
	/** Aggregate quantity across all of this address's in-head UTxOs (stringified bigint). */
	quantity: string;
}

export interface HydraHeadOwnBalance {
	hydraHeadId: string;
	/** The local participant's wallet address whose in-head funds are reported. */
	address: string;
	/** True when a live head snapshot was read; false when no provider/connection. */
	connected: boolean;
	/** Number of in-head UTxOs held by the local address (0 when disconnected). */
	utxoCount: number;
	/** Per-asset aggregate; empty when disconnected or no funds. */
	balance: HydraHeadBalanceAsset[];
}

const LOVELACE_UNITS = new Set(['', 'lovelace']);
const normalizeUnit = (unit: string): string => (LOVELACE_UNITS.has(unit.toLowerCase()) ? '' : unit);

/**
 * Aggregate a set of in-head UTxO amounts into a deterministic per-asset balance:
 * ADA (unit '') first, then tokens by unit; zero/negative totals dropped;
 * lovelace/'' normalised together. Pure and side-effect-free for unit testing.
 */
export function aggregateInHeadAmounts(
	utxoAmounts: ReadonlyArray<ReadonlyArray<{ unit: string; quantity: string }>>,
): HydraHeadBalanceAsset[] {
	const totals = new Map<string, bigint>();
	for (const amounts of utxoAmounts) {
		for (const amount of amounts) {
			const unit = normalizeUnit(amount.unit);
			let quantity: bigint;
			try {
				quantity = BigInt(amount.quantity);
			} catch {
				continue;
			}
			totals.set(unit, (totals.get(unit) ?? 0n) + quantity);
		}
	}
	return [...totals.entries()]
		.filter(([, quantity]) => quantity > 0n)
		.sort(([left], [right]) => (left === '' ? -1 : right === '' ? 1 : left.localeCompare(right)))
		.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

/**
 * Aggregate the local participant's in-head UTxOs into a per-asset balance. Returns
 * null when the head or its local participant/wallet is not found; returns a
 * `connected: false` result when the head has no live provider (e.g. not open).
 */
export async function getOwnInHeadBalance(hydraHeadId: string): Promise<HydraHeadOwnBalance | null> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
		select: { id: true, LocalParticipant: { select: { Wallet: { select: { walletAddress: true } } } } },
	});
	if (!head?.LocalParticipant?.Wallet?.walletAddress) {
		return null;
	}
	const address = head.LocalParticipant.Wallet.walletAddress;

	const provider = getHydraConnectionManager().getProvider(hydraHeadId);
	if (!provider) {
		return { hydraHeadId, address, connected: false, utxoCount: 0, balance: [] };
	}

	const utxos = await provider.fetchAddressUTxOs(address);
	const balance = aggregateInHeadAmounts(utxos.map((utxo) => utxo.output.amount));

	return { hydraHeadId, address, connected: true, utxoCount: utxos.length, balance };
}
