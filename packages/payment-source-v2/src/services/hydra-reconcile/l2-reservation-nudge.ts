/**
 * The release nudge: an in-head transaction that makes an expired L2
 * reservation provably dead.
 *
 * It spends every input of the reservation's body, all of which the pinned
 * wallet must own, into one output back to the wallet with a random nonce
 * datum. If it applies, the body can never apply, and its
 * output bytes are the proof release waits for (`./l2-release-nudge-proof`). If
 * the body applied first, its inputs are gone and the head rejects the nudge,
 * so the reservation stays held. The nudge also gives an idle head the new
 * snapshot that shows the result.
 *
 * The signed nudge is recorded on the reservation before it is sent and only
 * ever resent unchanged. So one reservation has at most one nudge, and the
 * wallet is freed only after that nudge applied, never while it is in flight.
 *
 * Mesh pinning (ADR-0005): V2 package, so `@meshsdk/core` is the beta.103 line.
 * The root (beta.96) HydraProvider is bridged in via `asV2Provider`.
 */
import { randomBytes } from 'node:crypto';
import { MeshTxBuilder, MeshWallet, type Asset, type UTxO } from '@meshsdk/core';
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
import {
	encodeL2ReleaseNudgeDatum,
	L2_RELEASE_NUDGE_NONCE_BYTES,
	readL2ReleaseNudgeProof,
	type L2ReleaseValueFloor,
} from './l2-release-nudge-proof';

/** At most one nudge per reservation in this window. A head confirms in about a second. */
export const L2_RELEASE_NUDGE_INTERVAL_MS = 5 * 60_000;
const MAX_NUDGE_THROTTLE_KEYS = 10_000;
const lastNudgeAtMs = new Map<string, number>();

export type L2ReleaseNudgeCandidate = {
	id: string;
	l2ReservationInputRefs: readonly string[];
	l2ReleaseNudgeTx: string | null;
	/** The funds the body locks, from our records (`./l2-release-nudge-proof`). */
	valueFloor: L2ReleaseValueFloor;
};

type NudgeNode = Pick<HydraNode, 'verifiedSnapshotNumber' | 'pendingIncrementUtxoRefs' | 'fetchPendingDecommitRefs'>;
type NudgeHead = Pick<CustomHydraHead, 'newTx'>;
type NudgeProvider = Pick<HydraProvider, 'fetchAddressUTxOs' | 'fetchProtocolParameters'>;

export type SignSpendNudge = (params: {
	inputs: readonly UTxO[];
	address: string;
	datumHex: string;
	network: Network;
	encryptedMnemonic: string;
	provider: NudgeProvider;
}) => Promise<string>;

export function toUtxoRef(utxo: UTxO): string {
	return `${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase();
}

/**
 * Every input of the body, as the wallet's UTxOs, or null unless each one is
 * at the wallet's own address, carries no reference script, and is not a
 * pending increment. Script inputs, such as an escrow a non-locking action
 * spends, are not the wallet's to spend, so such a body is never nudged.
 *
 * Nothing here filters on what the node reports present. A compromised node
 * could hide inputs to steer the nudge onto a subset, and the proof needs all
 * of them. An input that is really gone makes the head refuse the nudge.
 */
export function selectReleaseNudgeInputs(params: {
	utxos: readonly UTxO[];
	address: string;
	reservedRefs: readonly string[];
	pendingIncrementRefs: ReadonlySet<string>;
}): UTxO[] | null {
	const byRef = new Map(params.utxos.map((utxo) => [toUtxoRef(utxo), utxo]));
	const reserved = [...new Set(params.reservedRefs.map((reference) => reference.toLowerCase()))].sort();
	if (reserved.length === 0) return null;
	const selected: UTxO[] = [];
	for (const reference of reserved) {
		const utxo = byRef.get(reference);
		if (
			!utxo ||
			utxo.output.address !== params.address ||
			utxo.output.scriptRef != null ||
			params.pendingIncrementRefs.has(reference)
		) {
			return null;
		}
		selected.push(utxo);
	}
	return selected;
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
	signSpendNudge?: SignSpendNudge;
}): Promise<boolean> {
	const { hydraHeadId, candidate, node, nowMs, database = prisma, signSpendNudge = signInHeadSpendNudge } = params;
	if (!mayNudgeNow(candidate.id, nowMs)) return false;
	try {
		const provider =
			params.provider === undefined ? getHydraConnectionManager().getProvider(hydraHeadId) : params.provider;
		if (!provider) return false;
		if (node.verifiedSnapshotNumber === undefined) return false;

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

		// A withdrawal takes no wallet lock and may select the nudge's inputs, and
		// the head confirms no snapshot while a decommit is in flight.
		const activeWithdrawal = await database.hydraDecommit.findFirst({
			where: { hydraHeadId, status: { in: [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending] } },
			select: { id: true },
		});
		if (activeWithdrawal) return false;
		if ((await node.fetchPendingDecommitRefs()).length > 0) return false;

		const signedTx =
			candidate.l2ReleaseNudgeTx ??
			(await buildAndRecordNudge({
				hydraHeadId,
				candidate,
				wallet,
				inputs: selectReleaseNudgeInputs({
					utxos: await provider.fetchAddressUTxOs(wallet.walletAddress),
					address: wallet.walletAddress,
					reservedRefs: candidate.l2ReservationInputRefs,
					pendingIncrementRefs: node.pendingIncrementUtxoRefs,
				}),
				provider,
				database,
				signSpendNudge,
			}));
		if (signedTx === null) return false;
		const head = params.head === undefined ? getHydraConnectionManager().getHead(hydraHeadId) : params.head;
		if (!head) return false;
		const txHash = await head.newTx({ type: HydraTransactionType.TxConwayEra, description: '', cborHex: signedTx });
		logger.info('[HydraReconcile] sent release nudge for an expired L2 reservation', {
			hydraHeadId,
			transactionId: candidate.id,
			nudgeTxHash: txHash,
			resent: candidate.l2ReleaseNudgeTx !== null,
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

/** Sign and record a nudge over `inputs`. Null when there is nothing safe to send. */
async function buildAndRecordNudge(params: {
	hydraHeadId: string;
	candidate: L2ReleaseNudgeCandidate;
	wallet: { walletAddress: string; Secret: { encryptedMnemonic: string }; PaymentSource: { network: Network } };
	inputs: UTxO[] | null;
	provider: NudgeProvider;
	database: typeof prisma;
	signSpendNudge: SignSpendNudge;
}): Promise<string | null> {
	const { hydraHeadId, candidate, wallet, inputs, provider, database } = params;
	if (inputs === null) {
		logger.warn('[HydraReconcile] not every input of the expired L2 body is a wallet UTxO; reservation stays held', {
			hydraHeadId,
			transactionId: candidate.id,
		});
		return null;
	}

	const signedTx = await params.signSpendNudge({
		inputs,
		address: wallet.walletAddress,
		datumHex: encodeL2ReleaseNudgeDatum(randomBytes(L2_RELEASE_NUDGE_NONCE_BYTES)),
		network: wallet.PaymentSource.network,
		encryptedMnemonic: wallet.Secret.encryptedMnemonic,
		provider,
	});
	// Never record a nudge the release proof would not accept. This is also
	// where input values the node under-reported fall below the floor.
	if (readL2ReleaseNudgeProof(signedTx, candidate.l2ReservationInputRefs, candidate.valueFloor) === null) {
		throw new Error('Signed release nudge does not meet the release proof');
	}
	// Record before sending, and only over no nudge: a second, different nudge
	// could apply in place of the recorded one, and release would never see it.
	const recorded = await database.transaction.updateMany({
		where: { id: candidate.id, status: TransactionStatus.Pending, l2ReleaseNudgeTx: null },
		data: { l2ReleaseNudgeTx: signedTx },
	});
	return recorded.count === 1 ? signedTx : null;
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

/** Every unit the inputs hold, summed, lovelace first. */
export function sumNudgeInputValue(inputs: readonly UTxO[]): Asset[] {
	const totals = new Map<string, bigint>();
	for (const input of inputs) {
		for (const asset of input.output.amount) {
			const unit = asset.unit === '' ? 'lovelace' : asset.unit;
			totals.set(unit, (totals.get(unit) ?? 0n) + BigInt(asset.quantity));
		}
	}
	const units = [...totals.keys()].sort((a, b) => (a === 'lovelace' ? -1 : b === 'lovelace' ? 1 : a < b ? -1 : 1));
	return units.map((unit) => ({ unit, quantity: String(totals.get(unit)) }));
}

/**
 * The inputs into one output back to the same address, carrying the full
 * value and the nonce datum. The head charges no fee and its own parameters
 * are used, never L1's (see splitExactAmountInHead).
 */
export const signInHeadSpendNudge: SignSpendNudge = async ({
	inputs,
	address,
	datumHex,
	network,
	encryptedMnemonic,
	provider,
}) => {
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
	for (const input of inputs) {
		// scriptSize 0: without it mesh tries to resolve the in-head input on L1.
		builder.txIn(input.input.txHash, input.input.outputIndex, input.output.amount, input.output.address, 0);
	}
	builder.txOut(address, sumNudgeInputValue(inputs)).txOutInlineDatumValue(datumHex, 'CBOR');
	// The one output already carries every input's full value, so there is no
	// change to balance; mesh's balancer refuses a body that leaves none.
	const unsignedTx = builder.setFee('0').setNetwork(convertNetwork(network)).completeUnbalanced();
	return await wallet.signTx(unsignedTx);
};
