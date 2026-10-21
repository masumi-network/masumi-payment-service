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
import { HydraTopupStatus } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { getHydraConnectionManager } from './hydra-connection-manager.service';
import { l2TokenRisk } from '@/lib/hydra/hydra/l2-mint-tally';
import { inHeadUnit } from '@/utils/hydra/in-head-unit';
import type { UTxO } from '@meshsdk/core';

export interface HydraHeadBalanceAsset {
	/** Empty string for lovelace/ADA; otherwise policyId+assetName hex. */
	unit: string;
	/** Aggregate quantity across all of this address's in-head UTxOs (stringified bigint). */
	quantity: string;
}

export interface HydraHeadOwnBalance {
	/**
	 * In-head UTxOs the head reports that nothing on L1 backs.
	 *
	 * The head's snapshot can keep a deposit that was never really absorbed —
	 * hydra-node re-applies a deposit to the L2 ledger under two known bugs, one
	 * fixed in 2.3.0 and one still open. The funds show as spendable in the head
	 * while the L1 deposit has been recovered to the wallet, so the balance reads
	 * high and a Close fails on the overhead it implies.
	 *
	 * Reported rather than silently dropped: the head really does say it has
	 * them, and an operator comparing this screen with the deposits list needs to
	 * see which side is wrong rather than watch the numbers disagree.
	 */
	unbackedLovelace: string;
	/** Whether any UTxO here is unbacked, so the balance above is optimistic. */
	hasUnbackedUtxos: boolean;
	/**
	 * Own UTxOs that carry a token minted or burned inside the head whose net is
	 * not back at zero, as far as the history replay has checked: 0 until the
	 * replay is current, and a token UTxO it has not reached is not counted.
	 *
	 * The service never spends them (see `l2-mint-tally`): an unburned L2-minted
	 * token can never leave the head, and spending the UTxO would carry it into
	 * our change.
	 * Their ADA stays counted in `balance`, because the head does hold it.
	 * A peer can create such an output at this address.
	 */
	l2MintedUtxoCount: number;
	/** Lovelace held by those UTxOs. */
	l2MintedLovelace: string;
	/**
	 * Whether the history replay is current, so the two fields above count every
	 * L2-minted UTxO it has verified. False when not connected, right after a
	 * connect until the replay completes, and while the replay has failed: then
	 * no UTxO counts as L2-minted, and `spendableBalance` can read high.
	 */
	l2MintChecked: boolean;
	/**
	 * `balance` without those UTxOs. Low-balance rules read this. It still counts
	 * token UTxOs the replay has not checked and UTxOs of a deposit the head has
	 * not finished folding in, which the service does not spend yet either.
	 */
	spendableBalance: HydraHeadBalanceAsset[];
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
			const unit = inHeadUnit(amount.unit);
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
		select: {
			id: true,
			LocalParticipant: {
				select: {
					Wallet: {
						select: {
							walletAddress: true,
							PaymentSource: {
								select: { network: true, PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
							},
						},
					},
				},
			},
		},
	});
	if (!head?.LocalParticipant?.Wallet?.walletAddress) {
		return null;
	}
	const address = head.LocalParticipant.Wallet.walletAddress;

	const provider = getHydraConnectionManager().getProvider(hydraHeadId);
	if (!provider) {
		return {
			hydraHeadId,
			address,
			connected: false,
			utxoCount: 0,
			balance: [],
			unbackedLovelace: '0',
			hasUnbackedUtxos: false,
			l2MintedUtxoCount: 0,
			l2MintedLovelace: '0',
			l2MintChecked: false,
			spendableBalance: [],
		};
	}

	const utxos = await provider.fetchAddressUTxOs(address);

	// Cross-check against what we know L1 did with this head's deposits. A
	// recovered deposit's funds are back in the wallet, so an in-head UTxO still
	// carrying its reference is one the head believes in and the chain does not.
	// The validated deposit spends exactly the committed inputs at this wallet.
	// Read their full references from L1. A split hash also names uncommitted change.
	const recovered = await prisma.hydraTopup.findMany({
		where: { hydraHeadId, status: HydraTopupStatus.Recovered },
		select: { depositTxHash: true },
	});
	const recoveredReferences = new Set<string>();
	if (utxos.length > 0 && recovered.length > 0) {
		const source = head.LocalParticipant.Wallet.PaymentSource;
		const chain = getBlockfrostInstance(source.network, source.PaymentSourceConfig.rpcProviderApiKey);
		try {
			for (const deposit of recovered) {
				if (deposit.depositTxHash === null) continue;
				const transaction = await chain.txsUtxos(deposit.depositTxHash);
				for (const input of transaction.inputs) {
					if (input.address === address && !input.collateral && !input.reference) {
						recoveredReferences.add(`${input.tx_hash}#${input.output_index}`);
					}
				}
			}
		} catch (error) {
			logger.warn('[HydraBalance] could not read recovered deposit inputs', { hydraHeadId, error });
			throw createHttpError(502, 'Could not check recovered Hydra deposits against L1');
		}
	}
	const unbacked = utxos.filter((utxo) => recoveredReferences.has(`${utxo.input.txHash}#${utxo.input.outputIndex}`));
	const unbackedLovelace = unbacked.reduce((total, utxo) => {
		for (const asset of utxo.output.amount) {
			if (asset.unit === '' || asset.unit.toLowerCase() === 'lovelace') return total + BigInt(asset.quantity);
		}
		return total;
	}, 0n);
	if (unbacked.length > 0) {
		logger.warn('[HydraBalance] the head reports UTxOs whose deposits were recovered on L1', {
			hydraHeadId,
			unbackedUtxoCount: unbacked.length,
			unbackedLovelace: unbackedLovelace.toString(),
		});
	}

	const balance = aggregateInHeadAmounts(utxos.map((utxo) => utxo.output.amount));
	// Only a verified mint counts. A token UTxO the replay has not reached yet
	// is usually our own fresh change, and leaving it out would make the
	// spendable figure dip below a rule threshold for a moment and alert.
	const l2MintCheck = provider.getL2MintCheck();
	const isL2Minted = (utxo: UTxO) => l2TokenRisk(utxo, l2MintCheck) === 'minted';
	const l2Minted = utxos.filter(isL2Minted);
	const spendableBalance = aggregateInHeadAmounts(
		utxos.filter((utxo) => !isL2Minted(utxo)).map((utxo) => utxo.output.amount),
	);
	const l2MintedLovelace =
		aggregateInHeadAmounts(l2Minted.map((utxo) => utxo.output.amount)).find((asset) => asset.unit === '')?.quantity ??
		'0';

	return {
		hydraHeadId,
		address,
		connected: true,
		utxoCount: utxos.length,
		balance,
		unbackedLovelace: unbackedLovelace.toString(),
		hasUnbackedUtxos: unbacked.length > 0,
		l2MintedUtxoCount: l2Minted.length,
		l2MintedLovelace,
		l2MintChecked: l2MintCheck !== undefined,
		spendableBalance,
	};
}
