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
import { HydraDecommitStatus, HydraErrorType, HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { logger } from '@masumi/payment-core/logger';
import { HydraProvider, HydraTransactionType, HydraTransportAmbiguousError } from '@/lib/hydra';
import { fetchHydraDecommitInFlight } from '@/lib/hydra/hydra/node-control-queries';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { assertNodeReadyForDeposit, recordHeadError, verifyPersistedHydraHeadOnChain } from '@/routes/api/hydra/head';
import {
	amountOf,
	coverAssetForCarve,
	planLovelaceWithdrawal,
	IN_HEAD_COLLATERAL_RESERVE_LOVELACE,
	isAlreadyCarved,
	requiredChangeLovelace,
	topUpCarveInputs,
	lovelaceOf,
	selectDecommittableUtxos,
	utxoRef,
} from './select';
import {
	assertHydraHeadHostNotPaused,
	HYDRA_HOST_PAUSED_MESSAGE,
	isHydraHeadOnPausedHostLocked,
} from '@/services/hydra-host/pause';
import { describeErrorForOperator } from '@/services/hydra-head-error/operator-message';
import { staleWithdrawal } from './stale';
import { countLiveInHeadEscrows } from './live-escrows';
import { activeWithdrawalRefusal, claimableWalletWhere, liveEscrowsRefusal, WALLET_BUSY_MESSAGE } from './refusals';
import {
	assertSendableInHead,
	errorMessage,
	sleep,
	SPLIT_MAY_STILL_CONFIRM,
	splitExactAmountInHead,
	TOKEN_OUTPUT_LOVELACE,
} from './in-head-split';

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

/**
 * Marks the refusal for a wallet that is busy.
 *
 * A payment pending on the wallet is routine, not a failure of the head, and a
 * head error that routinely means nothing teaches an operator to ignore the
 * ones that matter.
 */
const WALLET_BUSY = Symbol.for('masumi.hydra.decommit.walletBusy');

function isMarked(error: unknown, mark: symbol): boolean {
	return typeof error === 'object' && error !== null && mark in error;
}

/**
 * How long a taken withdrawal waits for the head to drop its inputs.
 *
 * The node takes the request before the head agrees on it, and until the next
 * snapshot the leaving inputs still read as spendable. A payment that reserves
 * one of them is refused by the head, and its reservation then stays held until
 * an operator releases it. So the wallet goes back only once the inputs are
 * gone. A snapshot takes about a second; past this the stale-lock reaper frees
 * the wallet instead.
 */
const INPUTS_LEFT_TIMEOUT_MS = 10_000;
const INPUTS_LEFT_POLL_MS = 500;

/** Whether the head no longer lists any of these inputs at the address. */
async function haveInputsLeftHead(provider: HydraProvider, address: string, inputs: UTxO[]): Promise<boolean> {
	const leaving = new Set(inputs.map(utxoRef));
	const deadline = Date.now() + INPUTS_LEFT_TIMEOUT_MS;
	for (;;) {
		try {
			const current = await provider.fetchAddressUTxOs(address);
			if (!current.some((utxo) => leaving.has(utxoRef(utxo)))) return true;
		} catch (error) {
			logger.warn('[HydraDecommit] could not read the head to see the withdrawal inputs leave', {
				error: errorMessage(error),
			});
		}
		if (Date.now() >= deadline) return false;
		await sleep(INPUTS_LEFT_POLL_MS);
	}
}

/**
 * Give the hot wallet back.
 *
 * Scoped to the claim this withdrawal made, so a late release cannot free a lock
 * another holder took. Never allowed to replace the outcome of the withdrawal: a
 * failed release costs one stale lock, which the stale-lock reaper frees.
 */
async function releaseWallet(walletId: string, lockedAt: Date): Promise<void> {
	try {
		await prisma.hotWallet.updateMany({
			where: { id: walletId, lockedAt, pendingTransactionId: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.error('[HydraDecommit] could not release the hot wallet after a withdrawal', {
			walletId,
			error: errorMessage(error),
		});
	}
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
	await assertHydraHeadHostNotPaused(head.id);

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
	let walletLockedAt: Date | null = null;
	/** Set when the head may still apply something this withdrawal sent, so the wallet stays held. */
	let keepWalletLock = false;

	try {
		// Independently verify the head on chain before signing anything that moves
		// its funds, exactly as a top-up does. A head this service believes is open
		// but which is closing on L1 must not be handed a withdrawal.
		try {
			await verifyPersistedHydraHeadOnChain(head.id);
		} catch (verificationError) {
			if (createHttpError.isHttpError(verificationError)) throw verificationError;
			throw createHttpError(
				502,
				`Refusing to sign for an unverified Hydra head: ${describeErrorForOperator(verificationError)}`,
			);
		}

		// One withdrawal per participant at a time. The head itself only tracks one
		// pending decommit, so a second request would be refused by the node; being
		// refused here instead means the operator is told why, and no row is left
		// behind claiming a withdrawal is in flight when the head never took it.
		const claimSlot = (nodeHoldsNoWithdrawal: boolean) =>
			withSerializableSlotRetry(() =>
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
							const stale = staleWithdrawal(active, Date.now(), nodeHoldsNoWithdrawal);
							if (stale === null || stale === 'ask-node') {
								return { claimed: false as const, active, askNode: stale === 'ask-node' };
							}
							await tx.hydraDecommit.updateMany({
								where: { id: active.id, status: stale.status },
								data: { status: HydraDecommitStatus.Failed, failureReason: stale.reason },
							});
							logger.warn(
								`[HydraDecommit] failed a stale ${stale.status.toLowerCase()} withdrawal ${active.id} so a new one can start`,
							);
						}

						if (await isHydraHeadOnPausedHostLocked(tx, head.id)) throw createHttpError(409, HYDRA_HOST_PAUSED_MESSAGE);

						// Taking the collateral is only safe once nothing is left to spend
						// with it. The dialog explains the consequence, but a dialog is not a
						// guard: an escrow still live in the head becomes unspendable the
						// moment its wallet has no collateral, and the only way out of that
						// is closing the head. The head row lock is the one new escrow
						// reservations take, so the count and the drain mark are atomic with
						// respect to them: no escrow can enter after the count.
						if (params.drain === true) {
							await tx.$queryRaw`SELECT 1 FROM "HydraHead" WHERE "id" = ${head.id} FOR UPDATE`;
							const liveEscrows = await countLiveInHeadEscrows(tx, head.id);
							if (liveEscrows > 0) return { claimed: false as const, liveEscrows };
						}

						// The wallet every L2 action claims before it reserves funds. A payment
						// reservation takes it in the transaction that records the reservation
						// and its inputs, so a wallet that is claimed already has funds spoken
						// for, and a withdrawal that read them anyway would spend what that
						// payment was promised. A payment that starts while this runs misses its
						// own claim and retries. Thrown, not returned: a return commits this
						// transaction, the claim with it, and a throw rolls back everything it
						// wrote.
						const claimedAt = new Date();
						const walletClaim = await tx.hotWallet.updateMany({
							where: { id: localParticipant.walletId, ...claimableWalletWhere },
							data: { lockedAt: claimedAt },
						});
						if (walletClaim.count !== 1) {
							throw Object.assign(createHttpError(409, WALLET_BUSY_MESSAGE), { [WALLET_BUSY]: true });
						}

						if (params.drain === true) {
							await tx.hydraHead.update({ where: { id: head.id }, data: { collateralDrainedAt: new Date() } });
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
						return { claimed: true as const, id: created.id, walletLockedAt: claimedAt };
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
				),
			);

		// A stale Pending row is expired only on the node's word that it holds no
		// withdrawal. Asked outside the transaction, so a slow node never holds a
		// serializable slot, and the claim is re-run so the row is re-read after.
		let claim = await claimSlot(false);
		if (
			!claim.claimed &&
			'askNode' in claim &&
			claim.askNode &&
			(await fetchHydraDecommitInFlight(hydraHead.mainNode)) === false
		) {
			claim = await claimSlot(true);
		}

		if (!claim.claimed && claim.liveEscrows !== undefined) {
			throw createHttpError(409, liveEscrowsRefusal(claim.liveEscrows));
		}
		if (!claim.claimed) {
			throw createHttpError(409, activeWithdrawalRefusal(claim.active, claim.askNode));
		}
		preparingId = claim.id;
		walletLockedAt = claim.walletLockedAt;

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

		// Hydra produces no new snapshot while a previous decommit's utxoToDecommit
		// is non-empty — the node's chain follower has not yet observed that
		// decommit's DecrementTx on L1. Starting another in-head split during that
		// window gets a split that is TxValid but can never be snapshot-confirmed,
		// so this must be refused before any split is attempted, not discovered
		// after a 60s wait. Mirror of the deposit-side pendingIncrementRefs guard.
		// A node that cannot be asked is not a node with nothing pending.
		const pendingDecommits = await hydraHead.mainNode.fetchPendingDecommitRefs();
		if (pendingDecommits === undefined) {
			throw createHttpError(
				502,
				'Could not read the head state to check for a previous withdrawal still settling on L1; retry once the node answers',
			);
		}
		if (pendingDecommits.length > 0) {
			throw createHttpError(
				409,
				`A previous withdrawal is still being settled on L1 by the head (${pendingDecommits.length} output(s) pending); retry once it has finalized`,
			);
		}

		const inHeadUtxos = await provider.fetchAddressUTxOs(address);
		const recoveredRefs = await provider.getRecoveredInputRefs();
		const selection = selectDecommittableUtxos({
			utxos: inHeadUtxos,
			recoveredRefs,
			pendingIncrementRefs: hydraHead.mainNode.pendingIncrementUtxoRefs,
			l2MintCheck: hydraHead.mainNode.l2MintCheck,
			drain: params.drain === true,
		});

		// A token on the reserve can still be carved off it (see coverAssetForCarve),
		// so an asset request goes on to the carve rather than stopping here.
		if (selection.eligible.length === 0 && (params.asset == null || selection.reserved === null)) {
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
			const cover = coverAssetForCarve({
				eligible: selection.eligible,
				reserved: selection.reserved,
				unit: requestedAsset.unit,
				amount: requestedAsset.amount,
			});
			if (cover === null) {
				const usable = selection.reserved === null ? selection.eligible : [...selection.eligible, selection.reserved];
				const held = usable.reduce((total, utxo) => total + amountOf(utxo, requestedAsset.unit), 0n);
				// Say why the rest of the asset is held back; a bare "only 0" sent
				// operators looking for funds the balance plainly showed. The reserve
				// is counted in `held` above, so it is not held back here.
				const reservedRef = selection.reserved === null ? null : utxoRef(selection.reserved);
				const heldBack = new Set(
					inHeadUtxos.flatMap((utxo) => {
						const ref = utxoRef(utxo);
						if (ref === reservedRef || amountOf(utxo, requestedAsset.unit) === 0n) return [];
						const reason = selection.excluded.get(ref);
						return reason === undefined ? [] : [reason];
					}),
				);
				throw createHttpError(
					400,
					`Only ${held} of that asset is eligible to withdraw, which is less than the ${requestedAsset.amount} requested` +
						(heldBack.size > 0 ? `. Held back: ${[...heldBack].join('; ')}` : ''),
				);
			}
			const covering = cover.inputs;
			if (
				!cover.borrowsReserve &&
				isAlreadyCarved(covering, requestedAsset.unit, requestedAsset.amount, TOKEN_OUTPUT_LOVELACE)
			) {
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
				// A borrowed reserve must come back as collateral: the change is the
				// only output that stays in the head, so it carries the reserve's lovelace.
				const neededLovelace =
					TOKEN_OUTPUT_LOVELACE +
					(cover.borrowsReserve && changeFloor < IN_HEAD_COLLATERAL_RESERVE_LOVELACE
						? IN_HEAD_COLLATERAL_RESERVE_LOVELACE
						: changeFloor);
				const extra = topUpCarveInputs({ chosen: covering, eligible: selection.eligible, needed: neededLovelace });
				if (extra === null) {
					const available =
						selection.eligibleLovelace +
						(cover.borrowsReserve && selection.reserved !== null ? lovelaceOf(selection.reserved) : 0n);
					throw createHttpError(
						400,
						`Carving that asset onto its own UTxO needs ${neededLovelace} lovelace across the inputs, and only ` +
							`${available} is eligible in this head. ` +
							// A whole-UTxO withdrawal never takes the reserve, so it cannot reach a token on it.
							(cover.borrowsReserve
								? 'Add funds to the head so the collateral can stay behind.'
								: 'Add funds, or withdraw without naming an amount to take whole UTxOs.'),
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
			const requestedLovelace = params.lovelace;
			const plan = planLovelaceWithdrawal({
				eligible: selection.eligible,
				amount: requestedLovelace,
				baseChangeLovelace: MIN_SPLIT_REMAINDER_LOVELACE,
				perAssetChangeLovelace: PER_ASSET_CHANGE_LOVELACE,
			});
			if (plan.kind === 'insufficient') {
				throw createHttpError(
					400,
					`Only ${selection.eligibleLovelace} lovelace is eligible to withdraw, which is less than the ${requestedLovelace} requested`,
				);
			}
			if (plan.kind === 'remainder-too-small') {
				throw createHttpError(
					400,
					// A whole-UTxO withdrawal would take those assets out too, so
					// it is not suggested here.
					plan.coverHoldsAssets
						? `The ${requestedLovelace} lovelace that covers this withdrawal sits on UTxOs that also hold native assets, ` +
								'and no spare ADA is eligible to keep those assets in the head. Add funds to the head, or withdraw a little less.'
						: `Withdrawing ${requestedLovelace} lovelace would leave ${plan.remainder} behind, which is below the minimum a UTxO may hold. ` +
								'Withdraw a little less, or leave the amount out to take whole UTxOs.',
				);
			}
			if (plan.kind === 'whole') {
				decommitInputs = plan.inputs;
			} else {
				const split = await splitExactAmountInHead({
					wallet,
					provider,
					hydraHead,
					address,
					network,
					inputs: plan.inputs,
					unit: '',
					amount: requestedLovelace,
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
		// Before the row is Pending, where a refusal would read as the node's.
		assertSendableInHead(signedTx, headParameters.maxTxSize);
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

		// Kept, not thrown: the withdrawal itself has been requested either way.
		keepWalletLock = !(await haveInputsLeftHead(provider, address, decommitInputs));
		if (keepWalletLock) {
			logger.warn('[HydraDecommit] the withdrawal inputs are still in the head; leaving the wallet to the reaper', {
				decommitId: claim.id,
				decommitTxId,
			});
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
					data: { status: HydraDecommitStatus.Failed, failureReason: describeErrorForOperator(error).slice(0, 500) },
				})
				.catch((markError: unknown) => {
					logger.error(`[HydraDecommit] could not fail the preparing withdrawal ${preparingId}`, { error: markError });
				});
		}
		// Released when nothing this withdrawal sent can still apply: the request
		// never reached the head, or the node refused it. Held while the head may
		// still apply the request or its split, because the inputs of that body stay
		// spoken for; the stale-lock reaper frees it after WALLET_LOCK_TIMEOUT_INTERVAL,
		// as it does for a consolidation that may still confirm. A request the node
		// took is handled above: released once its inputs have left the head.
		// Or-ed, never reset: a failure after the request keeps a hold already decided.
		keepWalletLock =
			keepWalletLock ||
			isAcceptedButUnconfirmed(error) ||
			isMarked(error, SPLIT_MAY_STILL_CONFIRM) ||
			error instanceof HydraTransportAmbiguousError;
		if (!isAcceptedButUnconfirmed(error) && !isMarked(error, WALLET_BUSY)) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Decommit');
		}
		throw error;
	} finally {
		if (walletLockedAt !== null && !keepWalletLock) await releaseWallet(localParticipant.walletId, walletLockedAt);
	}
}
