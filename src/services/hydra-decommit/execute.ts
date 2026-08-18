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
import {
	HydraDecommitStatus,
	HydraErrorType,
	HydraHeadStatus,
	Network,
	Prisma,
	TransactionLayer,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { logger } from '@masumi/payment-core/logger';
import { CustomHydraHead, HydraProvider, HydraTransactionType, HydraTransportAmbiguousError } from '@/lib/hydra';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { assertNodeReadyForDeposit, recordHeadError, verifyPersistedHydraHeadOnChain } from '@/routes/api/hydra/head';
import {
	amountOf,
	coverAsset,
	coverLovelace,
	isAlreadyCarved,
	requiredChangeLovelace,
	topUpCarveInputs,
	lovelaceOf,
	selectDecommittableUtxos,
	utxoRef,
} from './select';

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

/**
 * After this, a Pending row is treated as one the head never received.
 *
 * A withdrawal request whose transport answer was ambiguous stays Pending on
 * purpose — only the head can say whether it took it. But nothing else could
 * ever move that row: `Pending` and `Approved` are written only by the head's
 * own events, so a request the node provably never saw (a Host-proxy 502 while
 * the node restarts is enough) left the row Pending for good, and the claim
 * above refuses every later withdrawal from that head. The only way out was to
 * close the head.
 *
 * An hour is far past any decommit round. The head answers a request it took
 * within seconds, with DecommitApproved or DecommitInvalid, and a reconnect
 * replays the whole history so a missed frame is re-delivered. It is also safe
 * if that reasoning is somehow wrong: hydra-node refuses a second decommit
 * while one is in flight, so a fresh request cannot become a second withdrawal
 * of the same funds — it is refused by the node instead.
 *
 * `Approved` is deliberately NOT aged out. The head approved it, so the funds
 * are on their way to L1, and only the settlement can close that row.
 */
const PENDING_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * The least a split may leave behind.
 *
 * A split produces the exact amount plus a remainder, and an output below the
 * ledger's minimum cannot exist — the builder would fail with a message about
 * value conservation that says nothing about the amount being the problem.
 * Comfortably above the minimum for a plain output at the head's
 * utxoCostPerByte, since the point is a clear refusal rather than a tight fit.
 */
const MIN_SPLIT_REMAINDER_LOVELACE = 2_000_000n;

/**
 * Added to the remainder for each native asset that stays on the change.
 *
 * Minimum ADA is charged per byte of the output, so a change output holding a
 * dozen tokens needs more than a plain one. Generous rather than exact: the
 * change returns to the operator's own address inside the head, so overshooting
 * costs nothing, while undershooting costs a withdrawal that the ledger refuses
 * after the split has already been built.
 */
const PER_ASSET_CHANGE_LOVELACE = 500_000n;

/**
 * Lovelace carried by a carved token output.
 *
 * A Cardano output cannot hold a token without enough ADA to exist, so an exact
 * token withdrawal takes this along and returns it to the wallet with the
 * asset. Comfortably above the minimum for a single-asset output.
 */
const TOKEN_OUTPUT_LOVELACE = 2_000_000n;

/**
 * Marks a refusal that is not a failure.
 *
 * The head accepted the withdrawal but the request could not confirm it, so it
 * settles asynchronously. The caller still gets a 502 — they asked a question
 * that has no answer yet — but nothing about the head has gone wrong, and it
 * must not be recorded as though it had.
 */
const ACCEPTED_BUT_UNCONFIRMED = Symbol.for('masumi.hydra.decommit.acceptedButUnconfirmed');

function isAcceptedButUnconfirmed(error: unknown): boolean {
	return typeof error === 'object' && error !== null && ACCEPTED_BUT_UNCONFIRMED in error;
}

export type ExecuteHydraDecommitParams = {
	headId: string;
	/**
	 * Lovelace to withdraw. Omit to withdraw every eligible UTxO whole.
	 *
	 * An exact amount costs an in-head split first; withdrawing whole UTxOs does
	 * not, and is the cheaper choice when the exact figure does not matter.
	 */
	lovelace?: bigint | null;
	/**
	 * Withdraw a native asset instead of ADA.
	 *
	 * A head can hold stablecoins and NFTs as readily as ADA, and until this
	 * existed the only way to get one back out was closing the head. The unit is
	 * policy id and asset name concatenated, and the amount is in that asset's
	 * own smallest unit.
	 */
	asset?: { unit: string; amount: bigint } | null;
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
	// A withdrawal makes no L1 deposit, so it has no deadline to miss — but it
	// still needs the head to sign, and a node that is catching up will not.
	// Without this the request gets as far as a reservation the head then never
	// resolves, which is a row an operator has to reason about rather than a
	// refusal they can act on.
	await assertNodeReadyForDeposit(localParticipant.id);

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
						const stale =
							active.status === HydraDecommitStatus.Preparing &&
							Date.now() - active.createdAt.getTime() > PREPARING_STALE_AFTER_MS
								? { status: HydraDecommitStatus.Preparing, reason: 'the in-head split never confirmed' }
								: active.status === HydraDecommitStatus.Pending &&
									  Date.now() - active.updatedAt.getTime() > PENDING_STALE_AFTER_MS
									? {
											status: HydraDecommitStatus.Pending,
											reason: 'the head never answered the withdrawal request',
										}
									: null;
						if (stale === null) return { claimed: false as const, active };
						await tx.hydraDecommit.updateMany({
							where: { id: active.id, status: stale.status },
							data: { status: HydraDecommitStatus.Failed, failureReason: stale.reason },
						});
						logger.warn(
							`[HydraDecommit] failed a stale ${stale.status.toLowerCase()} withdrawal ${active.id} so a new one can start`,
						);
					}

					const created = await tx.hydraDecommit.create({
						data: {
							hydraHeadId: head.id,
							hydraLocalParticipantId: localParticipant.id,
							requestedLovelace: params.lovelace ?? 0n,
							// From the request, so a token withdrawal does not read as
							// "0.00 tADA" for the whole time it is being prepared.
							requestedAssets: params.asset == null ? {} : { [params.asset.unit]: params.asset.amount.toString() },
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

		// Taking the collateral is only safe once nothing is left to spend with it.
		// The dialog explains the consequence, but a dialog is not a guard: an
		// escrow still live in the head becomes unspendable the moment its wallet
		// has no collateral, and the only way out of that is closing the head.
		if (params.drain === true) {
			const liveEscrows = await countLiveInHeadEscrows(head.id);
			if (liveEscrows > 0) {
				throw createHttpError(
					409,
					`Cannot withdraw the collateral while ${liveEscrows} escrow${liveEscrows === 1 ? ' is' : 's are'} still live in this head. ` +
						'Without collateral they could not be settled, and closing the head would be the only way to recover them. ' +
						'Settle them first, or withdraw an amount instead.',
				);
			}
		}

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
		const requestedAsset = params.asset ?? null;
		if (requestedAsset != null) {
			const covering = coverAsset(selection.eligible, requestedAsset.unit, requestedAsset.amount);
			if (covering === null) {
				const held = selection.eligible.reduce((total, utxo) => total + amountOf(utxo, requestedAsset.unit), 0n);
				throw createHttpError(
					400,
					`Only ${held} of that asset is eligible to withdraw, which is less than the ${requestedAsset.amount} requested`,
				);
			}
			if (isAlreadyCarved(covering, requestedAsset.unit, requestedAsset.amount, TOKEN_OUTPUT_LOVELACE)) {
				decommitInputs = covering;
			} else {
				// The carve produces two outputs — the token on its carrier, and the
				// remainder — so the inputs have to fund both. A token sitting on a
				// bare minimum-ADA UTxO cannot, which is ordinary rather than
				// exotic, so lovelace is borrowed from elsewhere in the head instead
				// of refusing.
				// Sized from what the change will actually hold, not from a flat
				// figure: every asset that does not leave on the carved output stays
				// on the change, and minimum ADA grows with them.
				const changeFloor = requiredChangeLovelace({
					inputs: covering,
					carvedUnit: requestedAsset.unit,
					carvedAmount: requestedAsset.amount,
					baseLovelace: MIN_SPLIT_REMAINDER_LOVELACE,
					perAssetLovelace: PER_ASSET_CHANGE_LOVELACE,
				});
				const neededLovelace = TOKEN_OUTPUT_LOVELACE + changeFloor;
				const extra = topUpCarveInputs({ chosen: covering, eligible: selection.eligible, needed: neededLovelace });
				if (extra === null) {
					const available = selection.eligibleLovelace;
					throw createHttpError(
						400,
						`Carving that asset onto its own UTxO needs ${neededLovelace} lovelace across the inputs, and only ` +
							`${available} is eligible in this head. Add funds, or withdraw without naming an amount to take whole UTxOs.`,
					);
				}
				const split = await splitExactAmountInHead({
					wallet,
					provider,
					hydraHead,
					address,
					network,
					inputs: [...covering, ...extra],
					unit: requestedAsset.unit,
					amount: requestedAsset.amount,
					decommitId: claim.id,
				});
				splitTxId = split.txId;
				decommitInputs = [split.exact];
			}
		} else if (params.lovelace != null) {
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
				if (covered - params.lovelace < MIN_SPLIT_REMAINDER_LOVELACE) {
					throw createHttpError(
						400,
						`Withdrawing ${params.lovelace} lovelace would leave ${covered - params.lovelace} behind, which is below the minimum a UTxO may hold. ` +
							'Withdraw a little less, or leave the amount out to take whole UTxOs.',
					);
				}
				const split = await splitExactAmountInHead({
					wallet,
					provider,
					hydraHead,
					address,
					network,
					inputs: covering,
					unit: '',
					amount: params.lovelace,
					decommitId: claim.id,
				});
				splitTxId = split.txId;
				decommitInputs = [split.exact];
			}
		} else {
			decommitInputs = selection.eligible;
		}

		const withdrawnLovelace = decommitInputs.reduce((total, utxo) => total + lovelaceOf(utxo), 0n);
		// Everything else leaving with it. A decommit takes whole outputs, so an
		// NFT withdrawal carries the ADA that output happened to hold, and an
		// amount alone described neither: the row read "5.00 tADA" for a
		// withdrawal whose point was the token.
		const withdrawnAssets: Record<string, string> = {};
		for (const utxo of decommitInputs) {
			for (const asset of utxo.output.amount) {
				if (asset.unit === '' || asset.unit.toLowerCase() === 'lovelace') continue;
				withdrawnAssets[asset.unit] = (BigInt(withdrawnAssets[asset.unit] ?? '0') + BigInt(asset.quantity)).toString();
			}
		}

		// The decommit transaction itself: spend the chosen inputs, send everything
		// to the participant's own address. Every output leaves the head, so there
		// is deliberately no change output beyond that one.
		// The head's OWN ledger parameters, fetched from the head, never assumed.
		//
		// An in-head transaction is validated by the head's ledger, not L1's, and
		// this head charges no fee at all (txFeeFixed 0, txFeePerByte 0, execution
		// prices 0) while still enforcing a real minimum-UTxO and 150% collateral.
		// Built without them, Mesh applied mainnet fee parameters to a transaction
		// that never leaves the head: the fee was simply burned, and burning it
		// changed the head's ADA overhead. `headAdaOverhead` is an invariant the
		// head validator checks on every transition — mustPreserveHeadAdaOverhead,
		// error H65 — so each fee-paying withdrawal moved the head one step further
		// from ever being closeable.
		//
		// Fetched rather than flagged. MeshTxBuilder's `isHydra` shortcut zeroes the
		// fee knobs but also sets collateralPercent to 0, which this head does not
		// agree with, and it would silently diverge from any head configured
		// differently.
		const headParameters = await provider.fetchProtocolParameters();
		const builder = new MeshTxBuilder({
			fetcher: provider,
			submitter: provider,
			params: headParameters,
			verbose: false,
		});
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
				requestedAssets: withdrawnAssets,
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
				// Not a head error. The request was accepted and the withdrawal is
				// settling normally; recording one here put a CommandFailed against
				// the head on every single withdrawal, describing something that had
				// already succeeded by the time anyone read it. Errors that routinely
				// mean nothing are worse than none, because they are what teaches an
				// operator to ignore the ones that matter.
				throw Object.assign(
					createHttpError(
						502,
						`The withdrawal could not be confirmed as requested (${decommitTxId}). It stays pending until the head settles it`,
					),
					{ [ACCEPTED_BUT_UNCONFIRMED]: true },
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
		if (!isAcceptedButUnconfirmed(error)) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Decommit');
		}
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
	/** Empty unit means lovelace. */
	unit: string;
	amount: bigint;
	decommitId: string;
}): Promise<{ txId: string; exact: UTxO }> {
	const { wallet, provider, hydraHead, address, network, inputs, unit, amount, decommitId } = params;
	const isLovelace = unit === '' || unit.toLowerCase() === 'lovelace';

	// The head's OWN ledger parameters, fetched from the head, never assumed.
	//
	// An in-head transaction is validated by the head's ledger, not L1's, and
	// this head charges no fee at all (txFeeFixed 0, txFeePerByte 0, execution
	// prices 0) while still enforcing a real minimum-UTxO and 150% collateral.
	// Built without them, Mesh applied mainnet fee parameters to a transaction
	// that never leaves the head: the fee was simply burned, and burning it
	// changed the head's ADA overhead. `headAdaOverhead` is an invariant the
	// head validator checks on every transition — mustPreserveHeadAdaOverhead,
	// error H65 — so each fee-paying withdrawal moved the head one step further
	// from ever being closeable.
	//
	// Fetched rather than flagged. MeshTxBuilder's `isHydra` shortcut zeroes the
	// fee knobs but also sets collateralPercent to 0, which this head does not
	// agree with, and it would silently diverge from any head configured
	// differently.
	const headParameters = await provider.fetchProtocolParameters();
	const builder = new MeshTxBuilder({
		fetcher: provider,
		submitter: provider,
		params: headParameters,
		verbose: false,
	});
	for (const utxo of inputs) {
		builder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
	}
	// A token cannot travel on its own: every output needs enough lovelace to
	// exist, so the carved UTxO carries the asked-for amount plus that floor, and
	// the floor comes back with it when the withdrawal lands.
	const carvedValue = isLovelace
		? [{ unit: 'lovelace', quantity: amount.toString() }]
		: [
				{ unit: 'lovelace', quantity: TOKEN_OUTPUT_LOVELACE.toString() },
				{ unit, quantity: amount.toString() },
			];
	const unsignedTx = await builder
		.txOut(address, carvedValue)
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
	const exact = produced.find(
		(utxo) =>
			utxo.output.address === address &&
			amountOf(utxo, isLovelace ? '' : unit) === amount &&
			(isLovelace || lovelaceOf(utxo) === TOKEN_OUTPUT_LOVELACE),
	);
	if (!exact) {
		throw createHttpError(
			502,
			`The in-head split ${splitTxId} confirmed but produced no output of exactly ${amount} ${isLovelace ? 'lovelace' : unit}`,
		);
	}
	logger.info(`[HydraDecommit] split ${amount} ${isLovelace ? 'lovelace' : unit} into ${utxoRef(exact)} in head`);
	return { txId: splitTxId, exact };
}

/**
 * Escrows this head still holds that have not settled.
 *
 * "Live" means the request still points at an in-head UTxO: an escrow that has
 * reached a terminal state has no `currentHydraUtxoTxHash` and needs nothing
 * further from this wallet. Both sides are counted, because a wallet can be
 * buyer on one escrow and seller on another in the same head.
 */
async function countLiveInHeadEscrows(hydraHeadId: string): Promise<number> {
	const where = {
		currentHydraUtxoTxHash: { not: null },
		CurrentTransaction: { is: { hydraHeadId, layer: TransactionLayer.L2 } },
	} as const;
	const [payments, purchases] = await Promise.all([
		prisma.paymentRequest.count({ where }),
		prisma.purchaseRequest.count({ where }),
	]);
	return payments + purchases;
}
