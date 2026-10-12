import createHttpError from 'http-errors';
import type { UTxO } from '@meshsdk/core';
import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { prepareOwnerDecommit } from '@masumi/payment-source-v2/smart-wallet/hydra-transfer';
import { HydraTransactionType } from '@/lib/hydra';
import { HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { decrypt } from '@/utils/security/encryption';
import { findGuardedWalletInHead } from './location';
import {
	assertHotWalletIdle,
	assertNoOpenTransfer,
	loadGuardedHotWallet,
	loadParticipantHead,
	loadTransferToSubmit,
	markTransferSubmitted,
	transferView,
	withGuardedWalletLock,
} from './transfers';

type Scope = Parameters<typeof loadGuardedHotWallet>[1];

// The head charges no fee, but a script spend still needs a collateral input. A
// plain ADA-only UTxO of this size is what the L2 purchase path also uses.
const MIN_L2_COLLATERAL_LOVELACE = 5_000_000n;

// The decommit carries no validity bound, so the service bounds it instead: an
// unsigned withdraw stops blocking guarded purchases and new moves after this.
const WITHDRAW_SIGN_WINDOW_MS = 15 * 60 * 1000;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The agent's plain, ADA-only in-head UTxO: it backs the script spend and is signed by the agent key. */
export function pickAgentCollateral(snapshot: UTxO[], agentAddress: string): UTxO | null {
	const candidates = snapshot.filter(
		(utxo) =>
			utxo.output.address === agentAddress &&
			utxo.output.plutusData == null &&
			utxo.output.amount.length === 1 &&
			utxo.output.amount[0].unit === 'lovelace' &&
			BigInt(utxo.output.amount[0].quantity) >= MIN_L2_COLLATERAL_LOVELACE,
	);
	candidates.sort((a, b) => Number(BigInt(a.output.amount[0].quantity) - BigInt(b.output.amount[0].quantity)));
	return candidates[0] ?? null;
}

/**
 * Step 1 of a withdraw: build the in-head transaction that pays the wallet back to
 * L1 unchanged, sign it for the agent's collateral, and hand it to the owner.
 */
export async function prepareGuardedWithdraw(input: { hotWalletId: string }, scope: Scope) {
	const { hotWallet, guarded, params } = await loadGuardedHotWallet(input.hotWalletId, scope);
	await assertNoOpenTransfer(guarded.id);
	await assertHotWalletIdle(hotWallet.id);
	const located = await findGuardedWalletInHead(hotWallet.id, guarded);
	if (located == null) throw createHttpError(409, 'The wallet is not inside a connected Hydra head');
	await loadParticipantHead(located.hydraHeadId, hotWallet.id);

	const collateral = pickAgentCollateral(located.snapshot, hotWallet.walletAddress);
	if (collateral == null) {
		throw createHttpError(
			409,
			`The hot wallet needs a plain ADA-only UTxO of at least ${MIN_L2_COLLATERAL_LOVELACE} lovelace inside the head as collateral; top it up first`,
		);
	}
	const provider = getHydraConnectionManager().getProvider(located.hydraHeadId);
	if (provider == null) throw createHttpError(502, 'No active connection to the Hydra head');

	const secret = await prisma.hotWallet.findUniqueOrThrow({
		where: { id: hotWallet.id },
		select: { Secret: { select: { encryptedMnemonic: true } } },
	});
	let built: Awaited<ReturnType<typeof prepareOwnerDecommit>>;
	try {
		built = await prepareOwnerDecommit({
			wallet: params,
			walletUtxo: located.walletUtxo,
			collateral,
			headCostModels: await provider.fetchRawCostModels(),
			agentMnemonic: decrypt(secret.Secret.encryptedMnemonic).split(' '),
		});
	} catch (error) {
		throw createHttpError(502, `Could not build the withdraw transaction: ${describeError(error)}`);
	}

	const transfer = await withGuardedWalletLock(guarded.id, async (tx) => {
		await assertNoOpenTransfer(guarded.id, new Date(), tx);
		return await tx.guardedHydraTransfer.create({
			data: {
				guardedWalletId: guarded.id,
				hydraHeadId: located.hydraHeadId,
				direction: GuardedHydraTransferDirection.Withdraw,
				status: GuardedHydraTransferStatus.Prepared,
				txHash: built.txHash,
				unsignedTx: built.unsignedTx,
				walletUtxoRef: `${located.walletUtxo.input.txHash}#${located.walletUtxo.input.outputIndex}`,
				signBefore: new Date(Date.now() + WITHDRAW_SIGN_WINDOW_MS),
			},
		});
	});
	logger.info('Prepared a guarded wallet withdraw', { transferId: transfer.id, hydraHeadId: located.hydraHeadId });
	return { transfer: transferView(transfer), unsignedTx: transfer.unsignedTx };
}

/** Step 2 of a withdraw: the owner-signed transaction goes to the head as a decommit. */
export async function submitGuardedWithdraw(input: { transferId: string; signedTx: string }, scope: Scope) {
	const transfer = await loadTransferToSubmit({
		transferId: input.transferId,
		direction: GuardedHydraTransferDirection.Withdraw,
		signedTx: input.signedTx,
		scope,
	});
	const { participant, hydraHead } = await loadParticipantHead(
		transfer.hydraHeadId,
		transfer.GuardedWallet.hotWalletId,
	);
	await assertHotWalletIdle(transfer.GuardedWallet.hotWalletId);
	const submitted = await markTransferSubmitted(transfer);
	try {
		await hydraHead.decommit(
			{ type: HydraTransactionType.TxConwayEra, description: '', cborHex: input.signedTx },
			participant.walletId,
		);
	} catch (error) {
		// No answer is not a no: the node may have taken it. The status read settles it.
		if (error instanceof HydraTransportAmbiguousError) {
			logger.warn('Submitting a guarded wallet withdraw gave no clear answer; leaving it Submitted', {
				transferId: transfer.id,
				error: describeError(error),
			});
			return { transfer: transferView(submitted) };
		}
		logger.warn('Submitting a guarded wallet withdraw failed', {
			transferId: transfer.id,
			error: describeError(error),
		});
		const failed = await prisma.guardedHydraTransfer.update({
			where: { id: transfer.id },
			data: { status: GuardedHydraTransferStatus.Failed, failureReason: describeError(error) },
		});
		return { transfer: transferView(failed) };
	}
	return { transfer: transferView(submitted) };
}
