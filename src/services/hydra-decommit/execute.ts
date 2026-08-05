/**
 * Withdrawing funds from an open head back to L1, without closing it.
 *
 * The mirror of the top-up flow, run backwards, and the asymmetry between them
 * is the whole design. A top-up starts on L1: the money sits at a deposit script
 * where it is visible and recoverable while the head decides, and a top-up that
 * fails leaves everything where it was. A withdrawal starts inside the head: the
 * head signs away the value first, and only then does its node post the L1
 * transaction that pays it out. There is no equivalent of recovery here, which
 * is why the guards sit before the request rather than after it.
 *
 * One shape is worth knowing before reading the flow: a decommit removes ALL of
 * its transaction's outputs from the head. There is no change staying behind. So
 * withdrawing part of a UTxO means first splitting the amount off inside the
 * head — the same reason a top-up carves a UTxO on L1, reached from the opposite
 * side. That split is an ordinary in-head transaction: free, and confirmed in
 * about a second, rather than the minutes an L1 carve costs.
 */

import createHttpError from 'http-errors';
import { MeshTxBuilder, MeshWallet, resolveTxHash, type UTxO } from '@meshsdk/core';
import { HydraDecommitStatus, HydraErrorType, HydraHeadStatus, Network, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { logger } from '@masumi/payment-core/logger';
import { CustomHydraHead, HydraProvider, HydraTransactionType, HydraTransportAmbiguousError } from '@/lib/hydra';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { recordHeadError, verifyPersistedHydraHeadOnChain } from '@/routes/api/hydra/head';
import { coverLovelace, lovelaceOf, selectDecommittableUtxos, utxoRef } from './select';

/**
 * How long the in-head split gets to confirm before the withdrawal gives up.
 *
 * An in-head transaction is a signature exchange between the parties, so this is
 * generous by two orders of magnitude. It exists for the case where the
 * counterparty has gone quiet mid-split, which would otherwise hold the
 * participant's only withdrawal slot open indefinitely.
 */
const SPLIT_CONFIRM_TIMEOUT_MS = 60_000;
const SPLIT_POLL_MS = 500;

/**
 * After this, a Preparing row is treated as abandoned.
 *
 * Same reasoning as the top-up's equivalent: a Preparing row blocks the next
 * withdrawal and nothing else can resolve one, because it has no decommit id for
 * the head's events to match. Much shorter here — the split it is waiting on is
 * an in-head transaction, not an L1 confirmation.
 */
const PREPARING_STALE_AFTER_MS = 10 * 60 * 1000;

export type ExecuteHydraDecommitParams = {
	headId: string;
	/**
	 * Lovelace to withdraw. Omit to withdraw every eligible UTxO whole.
	 *
	 * An exact amount costs an in-head split first; withdrawing whole UTxOs does
	 * not, and is the cheaper choice when the exact figure does not matter.
	 */
	lovelace?: bigint | null;
	/** Withdraw the collateral reserve too. For winding a head down. */
	drain?: boolean;
};

export type ExecuteHydraDecommitResult = {
	headId: string;
	decommitId: string;
	decommitTxId: string;
	splitTxId: string | null;
	withdrawnLovelace: bigint;
	destinationAddress: string;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function executeHydraDecommit(params: ExecuteHydraDecommitParams): Promise<ExecuteHydraDecommitResult> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: params.headId },
		include: { LocalParticipant: { include: { Wallet: { include: { Secret: true, PaymentSource: true } } } } },
	});

	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.isEnabled) throw createHttpError(409, 'Cannot withdraw from a disabled Hydra head');
	if (head.status !== HydraHeadStatus.Open) {
		throw createHttpError(409, `Cannot withdraw: head status is ${head.status}, expected Open`);
	}
	const localParticipant = head.LocalParticipant;
	if (!localParticipant) throw createHttpError(400, 'Head has no local participant');
	if (!head.headIdentifier) {
		throw createHttpError(409, 'Cannot withdraw before the Hydra head identifier has been observed');
	}

	const cm = getHydraConnectionManager();
	const hydraHead = cm.getHead(head.id);
	const provider = cm.getProvider(head.id);
	if (!hydraHead || !provider) throw createHttpError(502, 'No active connection to Hydra head');

	let preparingId: string | null = null;

	try {
		// Independently verify the head on chain before signing anything that moves
		// its funds, exactly as a top-up does. A head this service believes is open
		// but which is closing on L1 must not be handed a withdrawal.
		try {
			await verifyPersistedHydraHeadOnChain(head.id);
		} catch (verificationError) {
			if (createHttpError.isHttpError(verificationError)) throw verificationError;
			throw createHttpError(502, `Refusing to sign for an unverified Hydra head: ${errorMessage(verificationError)}`);
		}

		// One withdrawal per participant at a time. The head itself only tracks one
		// pending decommit, so a second request would be refused by the node; being
		// refused here instead means the operator is told why, and no row is left
		// behind claiming a withdrawal is in flight when the head never took it.
		const claim = await withSerializableSlotRetry(() =>
			prisma.$transaction(
				async (tx) => {
					const active = await tx.hydraDecommit.findFirst({
						where: {
							hydraLocalParticipantId: localParticipant.id,
							status: {
								in: [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending, HydraDecommitStatus.Approved],
							},
						},
						orderBy: { createdAt: 'desc' },
					});

					if (active !== null) {
						const isStalePreparation =
							active.status === HydraDecommitStatus.Preparing &&
							Date.now() - active.createdAt.getTime() > PREPARING_STALE_AFTER_MS;
						if (!isStalePreparation) return { claimed: false as const, active };
						await tx.hydraDecommit.updateMany({
							where: { id: active.id, status: HydraDecommitStatus.Preparing },
							data: { status: HydraDecommitStatus.Failed, failureReason: 'the in-head split never confirmed' },
						});
						logger.warn(`[HydraDecommit] failed a stale preparing withdrawal ${active.id} so a new one can start`);
					}

					const created = await tx.hydraDecommit.create({
						data: {
							hydraHeadId: head.id,
							hydraLocalParticipantId: localParticipant.id,
							requestedLovelace: params.lovelace ?? 0n,
							requestedAssets: {},
							destinationAddress: localParticipant.Wallet.walletAddress,
							status: HydraDecommitStatus.Preparing,
						},
						select: { id: true },
					});
					return { claimed: true as const, id: created.id };
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
			),
		);

		if (!claim.claimed) {
			throw createHttpError(
				409,
				claim.active.status === HydraDecommitStatus.Approved
					? 'A prior withdrawal has left the head and is still settling on L1'
					: 'A withdrawal from this head is already in progress',
			);
		}
		preparingId = claim.id;

		const network = localParticipant.Wallet.PaymentSource.network;
		const address = localParticipant.Wallet.walletAddress;

		// Bound to the head provider, so getUtxos() and the builder both see in-head
		// funds rather than L1 ones. The same construction the L2 lock path uses.
		const wallet = new MeshWallet({
			networkId: convertNetworkToId(network),
			fetcher: provider,
			submitter: provider,
			key: { type: 'mnemonic', words: decrypt(localParticipant.Wallet.Secret.encryptedMnemonic).split(' ') },
		});
		await wallet.getUnusedAddresses();

		const selection = selectDecommittableUtxos({
			utxos: await provider.fetchAddressUTxOs(address),
			pendingIncrementRefs: hydraHead.mainNode.pendingIncrementUtxoRefs,
			drain: params.drain === true,
		});

		if (selection.eligible.length === 0) {
			throw createHttpError(
				400,
				selection.excluded.size === 0
					? 'This wallet holds no funds in the head to withdraw'
					: `No in-head funds are eligible to withdraw: ${[...selection.excluded.values()].join('; ')}`,
			);
		}

		// Pick the inputs, and split off the exact amount when one was asked for.
		let splitTxId: string | null = null;
		let decommitInputs: UTxO[];
		if (params.lovelace != null) {
			const covering = coverLovelace(selection.eligible, params.lovelace);
			if (covering === null) {
				throw createHttpError(
					400,
					`Only ${selection.eligibleLovelace} lovelace is eligible to withdraw, which is less than the ${params.lovelace} requested`,
				);
			}
			const covered = covering.reduce((total, utxo) => total + lovelaceOf(utxo), 0n);
			if (covered === params.lovelace) {
				// The chosen UTxOs already come to exactly the amount, so the split
				// would be a transaction that changes nothing.
				decommitInputs = covering;
			} else {
				const split = await splitExactAmountInHead({
					wallet,
					provider,
					hydraHead,
					address,
					network,
					inputs: covering,
					lovelace: params.lovelace,
					decommitId: claim.id,
				});
				splitTxId = split.txId;
				decommitInputs = [split.exact];
			}
		} else {
			decommitInputs = selection.eligible;
		}

		const withdrawnLovelace = decommitInputs.reduce((total, utxo) => total + lovelaceOf(utxo), 0n);

		// The decommit transaction itself: spend the chosen inputs, send everything
		// to the participant's own address. Every output leaves the head, so there
		// is deliberately no change output beyond that one.
		const builder = new MeshTxBuilder({ fetcher: provider, submitter: provider, verbose: false });
		for (const utxo of decommitInputs) {
			builder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
		}
		const unsignedTx = await builder.changeAddress(address).setNetwork(convertNetwork(network)).complete();
		const signedTx = await wallet.signTx(unsignedTx, true);
		const decommitTxId = resolveTxHash(signedTx) as string;

		// Recorded BEFORE the request. The head answers over its socket, and an
		// approval can arrive before this call returns; a row without the id it is
		// matched on would miss it and sit as Pending over funds that have already
		// left the head.
		await prisma.hydraDecommit.update({
			where: { id: claim.id },
			data: {
				decommitTxId,
				splitTxId,
				requestedLovelace: withdrawnLovelace,
				status: HydraDecommitStatus.Pending,
			},
		});
		preparingId = null;

		try {
			await hydraHead.decommit(
				{ type: HydraTransactionType.TxConwayEra, description: '', cborHex: signedTx },
				localParticipant.walletId,
			);
		} catch (error) {
			// Only an answer from the node proves it never took the request. A
			// timeout, a dropped connection or a 5xx proves nothing: the node may
			// have accepted the decommit and be proposing it to the head right now,
			// and the head may approve it seconds later. Marking such a withdrawal
			// Failed would tell an operator "nothing left the head, safe to try
			// again" while the funds were on their way out — the same reason the L2
			// lock path keeps an ambiguous submit fail-closed rather than releasing
			// its reservation.
			//
			// So an ambiguous outcome stays Pending and is left to the head's own
			// DecommitApproved/DecommitInvalid, which is the only thing that can
			// settle it either way.
			if (error instanceof HydraTransportAmbiguousError) {
				logger.warn('[HydraDecommit] withdrawal request outcome is ambiguous; leaving it for the head to settle', {
					decommitId: claim.id,
					decommitTxId,
					error: errorMessage(error),
				});
				throw createHttpError(
					502,
					`The withdrawal could not be confirmed as requested (${decommitTxId}). It stays pending until the head settles it`,
				);
			}
			await prisma.hydraDecommit.updateMany({
				where: { id: claim.id, status: HydraDecommitStatus.Pending },
				data: {
					status: HydraDecommitStatus.Failed,
					failureReason: `the node rejected the withdrawal request: ${errorMessage(error)}`,
				},
			});
			throw createHttpError(502, `Hydra node rejected the withdrawal: ${errorMessage(error)}`);
		}

		await prisma.hydraHead.update({ where: { id: head.id }, data: { latestActivityAt: new Date() } });
		logger.info(`[HydraDecommit] requested withdrawal of ${withdrawnLovelace} lovelace from head ${head.id}`, {
			decommitTxId,
			splitTxId,
		});

		return {
			headId: head.id,
			decommitId: claim.id,
			decommitTxId,
			splitTxId,
			withdrawnLovelace,
			destinationAddress: address,
		};
	} catch (error) {
		// Nothing else resolves a Preparing row: it has no decommit id, so the
		// head's events can never match it, and left alone it would block this
		// participant's next withdrawal.
		if (preparingId !== null) {
			await prisma.hydraDecommit
				.updateMany({
					where: { id: preparingId, status: HydraDecommitStatus.Preparing },
					data: { status: HydraDecommitStatus.Failed, failureReason: errorMessage(error).slice(0, 500) },
				})
				.catch((markError: unknown) => {
					logger.error(`[HydraDecommit] could not fail the preparing withdrawal ${preparingId}`, { error: markError });
				});
		}
		await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Decommit');
		throw error;
	}
}

/**
 * Carve the exact amount into its own in-head UTxO.
 *
 * Ordinary in-head transaction: inputs from the wallet, one output of exactly
 * the requested lovelace, the remainder as change back to the same address.
 * Both outputs stay in the head — only the decommit that follows removes
 * anything.
 */
async function splitExactAmountInHead(params: {
	wallet: MeshWallet;
	provider: HydraProvider;
	hydraHead: CustomHydraHead;
	address: string;
	network: Network;
	inputs: UTxO[];
	lovelace: bigint;
	decommitId: string;
}): Promise<{ txId: string; exact: UTxO }> {
	const { wallet, provider, hydraHead, address, network, inputs, lovelace, decommitId } = params;

	const builder = new MeshTxBuilder({ fetcher: provider, submitter: provider, verbose: false });
	for (const utxo of inputs) {
		builder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
	}
	const unsignedTx = await builder
		.txOut(address, [{ unit: 'lovelace', quantity: lovelace.toString() }])
		.changeAddress(address)
		.setNetwork(convertNetwork(network))
		.complete();
	const signedTx = await wallet.signTx(unsignedTx, true);
	const splitTxId = resolveTxHash(signedTx) as string;

	await prisma.hydraDecommit.update({ where: { id: decommitId }, data: { splitTxId } });

	await hydraHead.newTx({ type: HydraTransactionType.TxConwayEra, description: '', cborHex: signedTx });

	// Wait for the head to confirm it before spending its output. The head's own
	// confirmation is the only evidence that the split exists; building the
	// decommit against an unconfirmed output would be refused as an unknown input.
	const deadline = Date.now() + SPLIT_CONFIRM_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (hydraHead.mainNode.isTxConfirmed(splitTxId)) break;
		await sleep(SPLIT_POLL_MS);
	}
	if (!hydraHead.mainNode.isTxConfirmed(splitTxId)) {
		throw createHttpError(
			504,
			`The in-head split ${splitTxId} was not confirmed within ${SPLIT_CONFIRM_TIMEOUT_MS / 1000}s; nothing has left the head`,
		);
	}

	// Find the carved output by value. The builder places the explicit output
	// before the change, but reading the index off that convention would break
	// silently if it ever changed; matching on the amount cannot.
	const produced = await provider.fetchUTxOs(splitTxId);
	const exact = produced.find((utxo) => utxo.output.address === address && lovelaceOf(utxo) === lovelace);
	if (!exact) {
		throw createHttpError(
			502,
			`The in-head split ${splitTxId} confirmed but produced no output of exactly ${lovelace} lovelace`,
		);
	}
	logger.info(`[HydraDecommit] split ${lovelace} lovelace into ${utxoRef(exact)} inside the head`);
	return { txId: splitTxId, exact };
}
