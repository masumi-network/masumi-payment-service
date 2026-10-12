import createHttpError from 'http-errors';
import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import {
	GuardedHydraTransferDirection,
	GuardedHydraTransferStatus,
	HydraHeadStatus,
	type GuardedWallet,
	type Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import type { GuardedWalletParams } from '@masumi/payment-source-v2/smart-wallet/guarded-wallet';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNetwork } from '@/utils/converter/network-convert';
import { loadPurchasingHotWallet } from '../service';
import { hasValidKeyWitness } from './witness';

type Scope = Parameters<typeof loadPurchasingHotWallet>[1];

/** The hot wallet, its guarded wallet, and the params that derive the wallet script. */
export async function loadGuardedHotWallet(hotWalletId: string, scope: Scope) {
	const hotWallet = await loadPurchasingHotWallet(hotWalletId, scope);
	const guarded = hotWallet.GuardedWallet;
	if (guarded == null) throw createHttpError(404, 'This hot wallet is not guarded');
	return { hotWallet, guarded, params: guardedWalletParams(guarded, hotWallet.PaymentSource.network) };
}

export function guardedWalletParams(
	guarded: Pick<GuardedWallet, 'ownerAddress' | 'quorumVkhs' | 'threshold' | 'stateTokenName'>,
	network: Parameters<typeof convertNetwork>[0],
): GuardedWalletParams {
	return {
		ownerAddress: guarded.ownerAddress,
		quorumVkhs: guarded.quorumVkhs,
		threshold: guarded.threshold,
		stateTokenName: guarded.stateTokenName,
		network: convertNetwork(network),
	};
}

/**
 * The open head the guarded wallet moves into or out of. The hot wallet must be
 * its local participant: purchases from the wallet inside the head are signed by
 * that hot wallet's key, and its in-head UTxOs are the collateral.
 */
export async function loadParticipantHead(hydraHeadId: string, hotWalletId: string) {
	const head = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
		select: {
			id: true,
			isEnabled: true,
			status: true,
			headIdentifier: true,
			LocalParticipant: { select: { id: true, walletId: true } },
		},
	});
	if (head == null) throw createHttpError(404, 'Hydra head not found');
	if (!head.isEnabled) throw createHttpError(409, 'The Hydra head is disabled');
	if (head.status !== HydraHeadStatus.Open) {
		throw createHttpError(409, `The Hydra head is ${head.status}, expected Open`);
	}
	if (head.headIdentifier == null) throw createHttpError(409, 'The Hydra head identifier is not observed yet');
	const participant = head.LocalParticipant;
	if (participant == null || participant.walletId !== hotWalletId) {
		throw createHttpError(409, 'This hot wallet is not the local participant of the Hydra head');
	}
	const hydraHead = getHydraConnectionManager().getHead(head.id);
	if (hydraHead == null) throw createHttpError(502, 'No active connection to the Hydra head');
	return { head: { ...head, headIdentifier: head.headIdentifier }, participant, hydraHead };
}

type TransferDb = Pick<Prisma.TransactionClient, 'guardedHydraTransfer'>;

/**
 * Runs `run` while holding the guarded wallet row. Two moves of one wallet then
 * see each other: the check and the write that follows it cannot interleave.
 */
export async function withGuardedWalletLock<T>(
	guardedWalletId: string,
	run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return await prisma.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM "GuardedWallet" WHERE id = ${guardedWalletId} FOR UPDATE`;
		return await run(tx);
	});
}

/**
 * A purchase in flight (the hot wallet lock) spends the wallet UTxO a move names.
 * A move now would race it and could only fail.
 */
export async function assertHotWalletIdle(hotWalletId: string): Promise<void> {
	const busy = await prisma.hotWallet.findFirst({
		where: { id: hotWalletId, OR: [{ lockedAt: { not: null } }, { pendingTransactionId: { not: null } }] },
		select: { id: true },
	});
	if (busy != null) throw createHttpError(409, 'The hot wallet is busy with a purchase; retry once it is unlocked');
}

/** One move at a time: a second one would spend the same wallet UTxO. */
export async function assertNoOpenTransfer(
	guardedWalletId: string,
	now = new Date(),
	db: TransferDb = prisma,
): Promise<void> {
	const open = await db.guardedHydraTransfer.findFirst({
		where: {
			guardedWalletId,
			OR: [
				{ status: GuardedHydraTransferStatus.Submitted },
				{
					status: GuardedHydraTransferStatus.Prepared,
					OR: [{ signBefore: null }, { signBefore: { gt: now } }],
				},
			],
		},
		select: { id: true, direction: true, status: true },
	});
	if (open != null) {
		throw createHttpError(
			409,
			`A ${open.direction.toLowerCase()} of this wallet is already ${open.status.toLowerCase()} (transfer ${open.id})`,
		);
	}
}

/**
 * The Prepared transfer an owner-signed transaction completes. Refuses a body
 * the service did not build and a transaction without the owner's witness.
 */
export async function loadTransferToSubmit(params: {
	transferId: string;
	direction: GuardedHydraTransferDirection;
	signedTx: string;
	scope: Scope;
}) {
	const transfer = await prisma.guardedHydraTransfer.findUnique({
		where: { id: params.transferId },
		include: { GuardedWallet: true },
	});
	if (transfer == null || transfer.direction !== params.direction) {
		throw createHttpError(404, 'Transfer not found');
	}
	// Scope: the caller must be able to see the hot wallet this transfer moves.
	const { guarded } = await loadGuardedHotWallet(transfer.GuardedWallet.hotWalletId, params.scope);
	if (transfer.status !== GuardedHydraTransferStatus.Prepared) {
		throw createHttpError(409, `The transfer is ${transfer.status}, expected Prepared`);
	}
	if (transfer.signBefore != null && transfer.signBefore.getTime() <= Date.now()) {
		await prisma.guardedHydraTransfer.update({
			where: { id: transfer.id },
			data: { status: GuardedHydraTransferStatus.Expired },
		});
		throw createHttpError(409, 'The transaction expired before it was signed; prepare a new one');
	}
	let bodyUnchanged: boolean;
	let ownerSigned: boolean;
	try {
		bodyUnchanged = transactionId(params.signedTx) === transfer.txHash;
		ownerSigned = hasValidKeyWitness(params.signedTx, transfer.txHash, ownerKeyHashOf(guarded.ownerAddress));
	} catch {
		throw createHttpError(400, 'signedTx is not a valid Cardano transaction');
	}
	if (!bodyUnchanged) throw createHttpError(400, 'signedTx changes the prepared transaction body');
	if (!ownerSigned) throw createHttpError(400, "signedTx lacks a valid witness from the wallet owner's key");
	return transfer;
}

/**
 * Prepared -> Submitted, once. A second submit of the same transfer, or of another
 * transfer while one is already in flight, gets a 409 instead of a second send.
 */
export async function markTransferSubmitted(transfer: { id: string; guardedWalletId: string }) {
	return await withGuardedWalletLock(transfer.guardedWalletId, async (tx) => {
		const inFlight = await tx.guardedHydraTransfer.findFirst({
			where: {
				guardedWalletId: transfer.guardedWalletId,
				status: GuardedHydraTransferStatus.Submitted,
				id: { not: transfer.id },
			},
			select: { id: true },
		});
		if (inFlight != null) throw createHttpError(409, `Transfer ${inFlight.id} of this wallet is already submitted`);
		const { count } = await tx.guardedHydraTransfer.updateMany({
			where: { id: transfer.id, status: GuardedHydraTransferStatus.Prepared },
			data: { status: GuardedHydraTransferStatus.Submitted, submittedAt: new Date() },
		});
		if (count === 0) throw createHttpError(409, 'The transfer is no longer Prepared');
		return await tx.guardedHydraTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
	});
}

export function transferView(transfer: {
	id: string;
	direction: GuardedHydraTransferDirection;
	status: GuardedHydraTransferStatus;
	hydraHeadId: string;
	txHash: string;
	walletUtxoRef: string;
	signBefore: Date | null;
	recoverableAt: Date | null;
	submittedAt: Date | null;
	confirmedAt: Date | null;
	failureReason: string | null;
	createdAt: Date;
}) {
	return {
		id: transfer.id,
		direction: transfer.direction,
		status: transfer.status,
		hydraHeadId: transfer.hydraHeadId,
		txHash: transfer.txHash,
		walletUtxoRef: transfer.walletUtxoRef,
		signBefore: transfer.signBefore,
		recoverableAt: transfer.recoverableAt,
		submittedAt: transfer.submittedAt,
		confirmedAt: transfer.confirmedAt,
		failureReason: transfer.failureReason,
		createdAt: transfer.createdAt,
	};
}

function transactionId(cborHex: string): string {
	return FixedTransaction.from_hex(cborHex).transaction_hash().to_hex();
}

export function ownerKeyHashOf(ownerAddress: string): string {
	return resolvePaymentKeyHash(ownerAddress);
}
