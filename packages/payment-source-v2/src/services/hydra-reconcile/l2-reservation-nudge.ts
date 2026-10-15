/**
 * Nudging an idle head so an expired L2 reservation can be proven dead.
 *
 * Release needs a verified snapshot newer than the node's own post-expiry one
 * (`decideL2ReservationRelease`). A head confirms a snapshot only when a
 * transaction lands, and the wallet the reservation pins is our side's only
 * in-head funds. With a quiet counterparty nothing ever lands: the wallet stays
 * pinned forever, and every purchase routed to it times out.
 *
 * The nudge is an in-head self-send of one wallet UTxO the reservation does not
 * spend. It leaves the input proof intact, and its snapshot is the newer one the
 * proof waits for. Its input is recorded on the reservation before sending, and
 * release waits until that input is spent. So the wallet is never freed while a
 * nudge is still in flight, and a new lock can never select its input.
 *
 * Mesh pinning (ADR-0005): V2 package, so `@meshsdk/core` is the beta.103 line.
 * The root (beta.96) HydraProvider is bridged in via `asV2Provider`.
 */
import { MeshTxBuilder, MeshWallet, type UTxO } from '@meshsdk/core';
import { HydraDecommitStatus, Network, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraTransactionType } from '@/lib/hydra';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import type { CustomHydraHead } from '@/lib/hydra/hydra/custom-head';
import type { HydraProvider } from '@/lib/hydra';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { asV2Provider } from '../provider-cast';

/** At most one nudge per reservation in this window. A head confirms in about a second. */
export const L2_RELEASE_NUDGE_INTERVAL_MS = 5 * 60_000;
const MAX_NUDGE_THROTTLE_KEYS = 10_000;
const lastNudgeAtMs = new Map<string, number>();

export type L2ReleaseNudgeCandidate = {
	id: string;
	l2ReservationInputRefs: readonly string[];
	l2ReleaseNudgeInputRef: string | null;
};

type NudgeNode = Pick<
	HydraNode,
	'verifiedSnapshotNumber' | 'getVerifiedCurrentOutput' | 'pendingIncrementUtxoRefs' | 'fetchPendingDecommitRefs'
>;
type NudgeHead = Pick<CustomHydraHead, 'newTx'>;
type NudgeProvider = Pick<HydraProvider, 'fetchAddressUTxOs' | 'fetchProtocolParameters'>;

export type SignSelfSend = (params: {
	input: UTxO;
	address: string;
	network: Network;
	encryptedMnemonic: string;
	provider: NudgeProvider;
}) => Promise<string>;

export function toUtxoRef(utxo: UTxO): string {
	return `${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase();
}

const isLovelaceUnit = (unit: string) => unit === '' || unit.toLowerCase() === 'lovelace';

/**
 * The wallet UTxO a nudge may spend: plain ADA at the wallet's own address, in
 * the verified snapshot, and touched by nothing else we know of. Lowest
 * reference first, so the choice is stable across scans.
 */
export function selectReleaseNudgeInput(params: {
	utxos: readonly UTxO[];
	address: string;
	reservedRefs: readonly string[];
	pendingIncrementRefs: ReadonlySet<string>;
	isVerified: (reference: string) => boolean;
}): UTxO | null {
	const reserved = new Set(params.reservedRefs.map((reference) => reference.toLowerCase()));
	const eligible = params.utxos.filter((utxo) => {
		const reference = toUtxoRef(utxo);
		return (
			utxo.output.address === params.address &&
			utxo.output.amount.every((asset) => isLovelaceUnit(asset.unit)) &&
			utxo.output.plutusData == null &&
			utxo.output.dataHash == null &&
			utxo.output.scriptRef == null &&
			!reserved.has(reference) &&
			!params.pendingIncrementRefs.has(reference) &&
			params.isVerified(reference)
		);
	});
	eligible.sort((a, b) => (toUtxoRef(a) < toUtxoRef(b) ? -1 : 1));
	return eligible[0] ?? null;
}

/**
 * Send one nudge for `candidate` if it is safe to. Never throws: a nudge that
 * does not go out leaves the reservation held, exactly as it was.
 */
export async function nudgeIdleHeadForRelease(params: {
	hydraHeadId: string;
	candidate: L2ReleaseNudgeCandidate;
	node: NudgeNode;
	/** Defaults to the head's live provider. */
	provider?: NudgeProvider | null;
	/** Defaults to the head's live session, read at send time so its mutation fence applies. */
	head?: NudgeHead | null;
	nowMs: number;
	database?: typeof prisma;
	signSelfSend?: SignSelfSend;
}): Promise<boolean> {
	const { hydraHeadId, candidate, node, nowMs, database = prisma, signSelfSend = signInHeadSelfSend } = params;
	if (!mayNudgeNow(candidate.id, nowMs)) return false;
	try {
		const provider =
			params.provider === undefined ? getHydraConnectionManager().getProvider(hydraHeadId) : params.provider;
		if (!provider) return false;
		const snapshotNumber = node.verifiedSnapshotNumber;
		if (snapshotNumber === undefined) return false;

		// Only the wallet this very reservation pins. Its lock owner is the dead
		// body, so no other L2 action can be building against it.
		const wallet = await database.hotWallet.findFirst({
			where: { pendingTransactionId: candidate.id, deletedAt: null },
			select: {
				walletAddress: true,
				Secret: { select: { encryptedMnemonic: true } },
				PaymentSource: { select: { network: true } },
			},
		});
		if (!wallet) return false;

		// A withdrawal takes no wallet lock, and the head confirms no snapshot
		// while a decommit is in flight, so a nudge then would only sit there.
		const activeWithdrawal = await database.hydraDecommit.findFirst({
			where: { hydraHeadId, status: { in: [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending] } },
			select: { id: true },
		});
		if (activeWithdrawal) return false;
		if ((await node.fetchPendingDecommitRefs()).length > 0) return false;

		const utxos = await provider.fetchAddressUTxOs(wallet.walletAddress);
		const isVerified = (reference: string) => node.getVerifiedCurrentOutput(reference, snapshotNumber) !== null;
		const recordedRef = candidate.l2ReleaseNudgeInputRef?.toLowerCase() ?? null;
		let input: UTxO | null;
		if (recordedRef !== null && isVerified(recordedRef)) {
			// Re-send against the recorded input. Every body spending it is the same
			// self-send, so at most one of them ever applies.
			input = utxos.find((utxo) => toUtxoRef(utxo) === recordedRef) ?? null;
		} else {
			// Nothing recorded yet, or the recorded input is spent, so no body of it
			// can apply again. The second case is a nudge that landed while the
			// in-memory baseline was lost (restart, failover): a fresh baseline now
			// sits on that snapshot and needs one more.
			input = selectReleaseNudgeInput({
				utxos,
				address: wallet.walletAddress,
				reservedRefs: candidate.l2ReservationInputRefs,
				pendingIncrementRefs: node.pendingIncrementUtxoRefs,
				isVerified,
			});
			if (input) {
				// Record before sending: once it is on the row, release waits for it.
				const recorded = await database.transaction.updateMany({
					where: {
						id: candidate.id,
						status: TransactionStatus.Pending,
						l2ReleaseNudgeInputRef: candidate.l2ReleaseNudgeInputRef,
					},
					data: { l2ReleaseNudgeInputRef: toUtxoRef(input) },
				});
				if (recorded.count !== 1) return false;
			}
		}
		if (!input) {
			logger.warn('[HydraReconcile] no wallet UTxO free to nudge the head; reservation stays held', {
				hydraHeadId,
				transactionId: candidate.id,
			});
			return false;
		}

		const signedTx = await signSelfSend({
			input,
			address: wallet.walletAddress,
			network: wallet.PaymentSource.network,
			encryptedMnemonic: wallet.Secret.encryptedMnemonic,
			provider,
		});
		const head = params.head === undefined ? getHydraConnectionManager().getHead(hydraHeadId) : params.head;
		if (!head) return false;
		const txHash = await head.newTx({ type: HydraTransactionType.TxConwayEra, description: '', cborHex: signedTx });
		logger.info('[HydraReconcile] nudged idle head so an expired L2 reservation can be released', {
			hydraHeadId,
			transactionId: candidate.id,
			nudgeTxHash: txHash,
			nudgeInputRef: toUtxoRef(input),
		});
		return true;
	} catch (error) {
		logger.warn('[HydraReconcile] release nudge failed; retrying after the nudge interval', {
			hydraHeadId,
			transactionId: candidate.id,
			error: error instanceof Error ? error.message : error,
		});
		return false;
	}
}

function mayNudgeNow(transactionId: string, nowMs: number): boolean {
	for (const [key, at] of lastNudgeAtMs) {
		if (at > nowMs || nowMs - at >= L2_RELEASE_NUDGE_INTERVAL_MS) lastNudgeAtMs.delete(key);
	}
	if (lastNudgeAtMs.has(transactionId) || lastNudgeAtMs.size >= MAX_NUDGE_THROTTLE_KEYS) return false;
	lastNudgeAtMs.set(transactionId, nowMs);
	return true;
}

/** Test seam: forget every throttle entry. */
export function resetL2ReleaseNudgeThrottle(): void {
	lastNudgeAtMs.clear();
}

/**
 * One input back to the same address. The head charges no fee and its own
 * parameters are used, never L1's (see splitExactAmountInHead).
 */
const signInHeadSelfSend: SignSelfSend = async ({ input, address, network, encryptedMnemonic, provider }) => {
	const v2Provider = asV2Provider(provider);
	const wallet = new MeshWallet({
		networkId: convertNetworkToId(network),
		fetcher: v2Provider,
		submitter: v2Provider,
		key: { type: 'mnemonic', words: decrypt(encryptedMnemonic).split(' ') },
	});
	await wallet.getUnusedAddresses();
	const builder = new MeshTxBuilder({ fetcher: v2Provider, isHydra: true });
	builder.protocolParams(await v2Provider.fetchProtocolParameters());
	// scriptSize 0: without it mesh tries to resolve the in-head input on L1.
	builder.txIn(input.input.txHash, input.input.outputIndex, input.output.amount, input.output.address, 0);
	const unsignedTx = await builder.setFee('0').changeAddress(address).setNetwork(convertNetwork(network)).complete();
	return await wallet.signTx(unsignedTx);
};
