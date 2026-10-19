/**
 * Merging a participant's in-head UTxOs into as few as possible.
 *
 * Purchases, payouts and refunds leave a wallet holding many small UTxOs inside
 * the head. That is untidy, and it also costs: escrow payouts carry a datum, and
 * a wallet spread over dozens of outputs is slow to select from. Consolidating
 * is an ordinary in-head self-send. The head charges no fee and confirms it in
 * about a second, and nothing leaves the head, so a consolidation that fails
 * leaves every UTxO where it was.
 */

import createHttpError from 'http-errors';
import { MeshTxBuilder, MeshWallet, resolveTxHash } from '@meshsdk/core';
import { HydraDecommitStatus, HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraTransactionType, HydraTransportAmbiguousError } from '@/lib/hydra';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { assertNodeReadyForDeposit } from '@/routes/api/hydra/head';
import { planConsolidation } from './select';
import { assertHydraHeadHostNotPaused } from '@/services/hydra-host/pause';

/** How long the head gets to confirm the self-send. Same bound as a withdrawal's split. */
const CONSOLIDATE_CONFIRM_TIMEOUT_MS = 60_000;
const CONSOLIDATE_POLL_MS = 500;

export type ExecuteHydraConsolidationResult = {
	headId: string;
	txId: string;
	inputCount: number;
	outputCount: number;
	/** Eligible UTxOs left for another round; non-zero means call again. */
	remainingCount: number;
};

export async function executeHydraConsolidation(headId: string): Promise<ExecuteHydraConsolidationResult> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: headId },
		include: { LocalParticipant: { include: { Wallet: { include: { Secret: true, PaymentSource: true } } } } },
	});
	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.isEnabled) throw createHttpError(409, 'Cannot consolidate in a disabled Hydra head');
	if (head.status !== HydraHeadStatus.Open) {
		throw createHttpError(409, `Cannot consolidate: head status is ${head.status}, expected Open`);
	}
	const localParticipant = head.LocalParticipant;
	if (!localParticipant) throw createHttpError(400, 'Head has no local participant');
	await assertHydraHeadHostNotPaused(head.id);

	const cm = getHydraConnectionManager();
	const hydraHead = cm.getHead(head.id);
	const provider = cm.getProvider(head.id);
	if (!hydraHead || !provider) throw createHttpError(502, 'No active connection to Hydra head');
	await assertNodeReadyForDeposit(localParticipant.id);

	// The head confirms no new snapshot while a decommit is in flight, so a
	// self-send started now would be accepted and never confirmed.
	const pendingDecommits = await hydraHead.mainNode.fetchPendingDecommitRefs();
	if (pendingDecommits.length > 0) {
		throw createHttpError(409, 'A withdrawal from this head is still settling on L1; retry once it has finalized');
	}
	// A withdrawal being prepared has split off a UTxO it is about to decommit,
	// and takes no wallet lock. Spending that UTxO here would fail the withdrawal.
	await assertNoActiveWithdrawal(localParticipant.id);

	const walletRow = localParticipant.Wallet;
	const address = walletRow.walletAddress;

	// Take the wallet lock every L2 action claims before it reserves funds, so
	// no reservation starts while this self-send is in flight. It does not stop
	// an L2 pass that read the UTxOs before this claim: such a lock is refused by
	// the head, and its reservation then needs the recovery path.
	const lockedAt = new Date();
	const claimed = await prisma.hotWallet.updateMany({
		where: { id: walletRow.id, deletedAt: null, lockedAt: null, pendingTransactionId: null, lockPurpose: null },
		data: { lockedAt },
	});
	if (claimed.count !== 1) {
		throw createHttpError(409, 'This wallet is busy with another transaction; retry in a few seconds');
	}

	// Released only when the outcome is known: confirmed, or never sent. A
	// self-send the head may still confirm keeps the lock, and the stale-lock
	// reaper frees it after WALLET_LOCK_TIMEOUT_INTERVAL.
	let releaseLock = true;
	try {
		const headParameters = await provider.fetchProtocolParameters();
		const plan = planConsolidation({
			utxos: await provider.fetchAddressUTxOs(address),
			pendingIncrementRefs: hydraHead.mainNode.pendingIncrementUtxoRefs,
			address,
			coinsPerUtxoSize: headParameters.coinsPerUtxoSize,
		});
		if (plan === null) {
			throw createHttpError(400, 'This wallet has nothing to consolidate in the head');
		}

		const wallet = new MeshWallet({
			networkId: convertNetworkToId(walletRow.PaymentSource.network),
			fetcher: provider,
			submitter: provider,
			key: { type: 'mnemonic', words: decrypt(walletRow.Secret.encryptedMnemonic).split(' ') },
		});
		await wallet.getUnusedAddresses();

		// The head's own parameters, never L1's: the head charges no fee, and a fee
		// burned in the head changes its ADA overhead (H65 at Close). See
		// splitExactAmountInHead in hydra-decommit/execute.ts.
		const builder = new MeshTxBuilder({
			fetcher: provider,
			submitter: provider,
			params: headParameters,
			verbose: false,
		});
		for (const utxo of plan.inputs) {
			builder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
		}
		if (plan.collateralLovelace !== null) {
			builder.txOut(address, [{ unit: 'lovelace', quantity: plan.collateralLovelace.toString() }]);
		}
		const unsignedTx = await builder
			.changeAddress(address)
			.setNetwork(convertNetwork(walletRow.PaymentSource.network))
			.complete();
		const signedTx = await wallet.signTx(unsignedTx, true);
		const txId = resolveTxHash(signedTx) as string;

		// Again, right before sending: a withdrawal takes no wallet lock, so one
		// may have started while this was being built.
		await assertNoActiveWithdrawal(localParticipant.id);
		// And the pause: this self-send leaves no row the pause can count as in
		// flight, so a pause that started during the build must stop it here.
		await assertHydraHeadHostNotPaused(head.id);
		releaseLock = false;
		try {
			await hydraHead.newTx({ type: HydraTransactionType.TxConwayEra, description: '', cborHex: signedTx });
		} catch (error) {
			// Anything but an ambiguous answer means the head did not take it.
			if (!(error instanceof HydraTransportAmbiguousError)) releaseLock = true;
			throw error;
		}

		const deadline = Date.now() + CONSOLIDATE_CONFIRM_TIMEOUT_MS;
		while (!hydraHead.mainNode.isTxConfirmed(txId) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, CONSOLIDATE_POLL_MS));
		}
		if (!hydraHead.mainNode.isTxConfirmed(txId)) {
			throw createHttpError(
				504,
				`The head accepted consolidation ${txId} but did not confirm it within ${CONSOLIDATE_CONFIRM_TIMEOUT_MS / 1000}s; the wallet stays locked until it settles`,
			);
		}
		releaseLock = true;

		const outputCount = plan.collateralLovelace === null ? 1 : 2;
		logger.info('[HydraConsolidate] merged in-head UTxOs', {
			hydraHeadId: head.id,
			txId,
			inputCount: plan.inputs.length,
			outputCount,
			remainingCount: plan.deferredCount,
		});
		return { headId: head.id, txId, inputCount: plan.inputs.length, outputCount, remainingCount: plan.deferredCount };
	} finally {
		if (releaseLock) {
			await prisma.hotWallet.updateMany({
				where: { id: walletRow.id, lockedAt, pendingTransactionId: null },
				data: { lockedAt: null },
			});
		}
	}
}

async function assertNoActiveWithdrawal(hydraLocalParticipantId: string): Promise<void> {
	const activeWithdrawal = await prisma.hydraDecommit.findFirst({
		where: {
			hydraLocalParticipantId,
			status: { in: [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending] },
		},
		select: { id: true },
	});
	if (activeWithdrawal !== null) {
		throw createHttpError(409, 'A withdrawal from this head is in progress; retry once it has left the head');
	}
}
