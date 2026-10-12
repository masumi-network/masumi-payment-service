import createHttpError from 'http-errors';
import { BlockfrostProvider, resolvePaymentKeyHash, slotToBeginUnixTime } from '@meshsdk/core';
import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { prepareOwnerDeposit } from '@masumi/payment-source-v2/smart-wallet/hydra-transfer';
import { draftAndValidateHydraCommit, HydraCommitFlowError, HydraTransactionType } from '@/lib/hydra';
import { HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';
import { assertNodeReadyForDeposit } from '@/routes/api/hydra/head';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
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

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Step 1 of a deposit: have the head's node draft the deposit of the wallet UTxO,
 * validate it, and hand the unsigned transaction to the owner. The node funds the
 * fee and collateral and has already signed for its own inputs; the owner's
 * witness is the only one missing.
 */
export async function prepareGuardedDeposit(input: { hotWalletId: string; hydraHeadId: string }, scope: Scope) {
	const { hotWallet, guarded, params } = await loadGuardedHotWallet(input.hotWalletId, scope);
	const { head, participant, hydraHead } = await loadParticipantHead(input.hydraHeadId, hotWallet.id);
	await assertNodeReadyForDeposit(participant.id);
	await assertNoOpenTransfer(guarded.id);
	await assertHotWalletIdle(hotWallet.id);
	if ((await findGuardedWalletInHead(hotWallet.id, guarded)) != null) {
		throw createHttpError(409, 'The wallet is already inside a Hydra head');
	}

	const network = convertNetwork(hotWallet.PaymentSource.network);
	const slotConfig = resolveHydraL2EvidenceSlotConfig(network);
	if (slotConfig == null) throw createHttpError(500, 'Hydra L1 slot configuration is incomplete or invalid');
	const rpcApiKey = hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;

	let prepared: Awaited<ReturnType<typeof prepareOwnerDeposit>>;
	try {
		prepared = await prepareOwnerDeposit({ wallet: params, rpcApiKey });
	} catch (error) {
		throw createHttpError(409, `The wallet could not be read on L1: ${describeError(error)}`);
	}
	if (prepared.scriptHash !== guarded.policyId) {
		throw createHttpError(409, 'The derived wallet script differs from the attached guarded wallet');
	}

	const l1 = new BlockfrostProvider(rpcApiKey);
	let draft: Awaited<ReturnType<typeof draftAndValidateHydraCommit>>;
	try {
		draft = await draftAndValidateHydraCommit({
			commitUtxos: [prepared.walletUtxo],
			// The owner's L1 UTxOs are never fetched; every non-committed input is
			// resolved on chain and refused when the owner key owns it.
			walletUtxos: [],
			walletPaymentKeyHash: prepared.ownerKeyHash,
			expectedHeadId: head.headIdentifier,
			slotConfig,
			scriptCommit: { scriptHash: prepared.scriptHash },
			deps: {
				requestCommitDraft: (commitUtxos) => hydraHead.commit(commitUtxos, prepared.blueprint, participant.walletId),
				resolveInputOutput: async (txHash, index) =>
					(await l1.fetchUTxOs(txHash, index)).find((utxo) => utxo.input.outputIndex === index)?.output ?? null,
				paymentKeyHashOf: resolvePaymentKeyHash,
			},
		});
	} catch (error) {
		if (error instanceof HydraCommitFlowError) {
			throw createHttpError(502, `Refusing the node's deposit draft: ${error.message}`);
		}
		throw createHttpError(502, `The node could not draft the deposit: ${describeError(error)}`);
	}

	const walletUtxoRef = `${prepared.walletUtxo.input.txHash}#${prepared.walletUtxo.input.outputIndex}`;
	const transfer = await withGuardedWalletLock(guarded.id, async (tx) => {
		await assertNoOpenTransfer(guarded.id, new Date(), tx);
		return await tx.guardedHydraTransfer.create({
			data: {
				guardedWalletId: guarded.id,
				hydraHeadId: head.id,
				direction: GuardedHydraTransferDirection.Deposit,
				status: GuardedHydraTransferStatus.Prepared,
				txHash: draft.txId,
				unsignedTx: draft.draft.cborHex,
				walletUtxoRef,
				signBefore: new Date(slotToBeginUnixTime(Number(draft.invalidHereafterSlot), slotConfig)),
				recoverableAt: new Date(draft.deadlineMs),
			},
		});
	});
	logger.info('Prepared a guarded wallet deposit', { transferId: transfer.id, hydraHeadId: head.id, walletUtxoRef });
	return { transfer: transferView(transfer), unsignedTx: transfer.unsignedTx };
}

/** Step 2 of a deposit: the owner-signed deposit goes to L1 through the head's node. */
export async function submitGuardedDeposit(input: { transferId: string; signedTx: string }, scope: Scope) {
	const transfer = await loadTransferToSubmit({
		transferId: input.transferId,
		direction: GuardedHydraTransferDirection.Deposit,
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
		await hydraHead.cardanoTransaction(
			{ type: HydraTransactionType.TxConwayEra, description: '', cborHex: input.signedTx },
			participant.walletId,
		);
	} catch (error) {
		// No answer is not a no: the node may have taken it. The status read settles it.
		if (error instanceof HydraTransportAmbiguousError) {
			logger.warn('Submitting a guarded wallet deposit gave no clear answer; leaving it Submitted', {
				transferId: transfer.id,
				error: describeError(error),
			});
			return { transfer: transferView(submitted) };
		}
		// A clear rejection is final: the node did not post it. Only a missing answer stays Submitted.
		logger.warn('Submitting a guarded wallet deposit failed', { transferId: transfer.id, error: describeError(error) });
		const failed = await prisma.guardedHydraTransfer.update({
			where: { id: transfer.id },
			data: { status: GuardedHydraTransferStatus.Failed, failureReason: describeError(error) },
		});
		return { transfer: transferView(failed) };
	}
	return { transfer: transferView(submitted) };
}
