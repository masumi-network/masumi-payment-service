import createHttpError from 'http-errors';
import { HydraErrorType, HydraHeadStatus, HydraTopupStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { logger } from '@masumi/payment-core/logger';
import {
	buildValidatedHydraCommit,
	HydraCommitFlowError,
	HydraTransactionType,
	interpretCardanoTxSubmitResult,
	selectCommitUtxos,
	selectCommitUtxosUpToTarget,
	type CommitUtxoFilter,
} from '@/lib/hydra';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import {
	HydraTopupReservationConflictError,
	reconcilePendingHydraTopup,
	reserveAndSubmitHydraTopup,
} from '@/services/hydra-topup-reconciliation';
import { buildHydraCommitFlowDeps } from '@/routes/api/hydra/head/commit-flow-deps';
import { assertNodeReadyForDeposit, recordHeadError, verifyPersistedHydraHeadOnChain } from '@/routes/api/hydra/head';
import { carveExactUtxo, HydraPreSplitError } from './pre-split';
import { claimHotWalletForL1, releaseHotWalletAfterL1 } from '@/utils/db/hot-wallet-lock';

/**
 * After this, a Preparing row is treated as abandoned.
 *
 * Nothing resolves such a row on its own: it has no deposit hash, so
 * reconciliation has nothing to look for, and the request that owns it is long
 * gone. Since Preparing also blocks the next top-up, leaving it would let one
 * crashed carve wedge the head's deposits for good. Comfortably longer than the
 * carve's own confirmation budget, so a slow chain is never mistaken for a
 * crash.
 */
const PREPARING_STALE_AFTER_MS = 30 * 60 * 1000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type ExecuteHydraTopupParams = {
	headId: string;
	/** Which plain wallet UTxOs to draw from. */
	filter: CommitUtxoFilter;
	/**
	 * Bound the top-up to the minimal whole-UTxO set reaching this amount of the
	 * given asset (auto-topup). Omit to commit every matching UTxO (manual top-up).
	 */
	target?: { unit: string; amount: bigint } | null;
	/**
	 * Exact-amount top-up: first carve a dedicated wallet UTxO of exactly this
	 * amount via an L1 self-payment (pre-split), then commit only that UTxO.
	 * Takes precedence over `filter`/`target`. Adds an L1 confirmation wait.
	 */
	exact?: { unit: string; amount: bigint } | null;
};

export type ExecuteHydraTopupResult = {
	headId: string;
	topupId: string;
	depositTxHash: string;
	confirmed: boolean;
	committedLovelace: bigint;
	committedAssets: Record<string, string>;
};

/**
 * Core repeatable incremental-commit (top-up) flow shared by the /hydra/head/topup
 * endpoint and the automatic low-balance top-up. Loads + independently verifies
 * the Open head, selects wallet UTxOs (optionally bounded to a target amount),
 * builds/validates/signs the deposit through the shared commit-flow path, then
 * reserves + submits it and reconciles once against L1. Throws http-errors with
 * meaningful status codes; the caller decides how to surface them.
 */
export async function executeHydraTopup(params: ExecuteHydraTopupParams): Promise<ExecuteHydraTopupResult> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: params.headId },
		include: { LocalParticipant: true },
	});

	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.isEnabled) throw createHttpError(409, 'Cannot top up a disabled Hydra head');
	if (head.status !== HydraHeadStatus.Open) {
		throw createHttpError(409, `Cannot top up: head status is ${head.status}, expected Open`);
	}
	const localParticipant = head.LocalParticipant;
	if (!localParticipant) throw createHttpError(400, 'Head has no local participant');
	// Deliberately does NOT require an initial commit. A head can open with an
	// empty commit — being a party is decided by Init, not by committing funds —
	// and such a head could otherwise never be funded at all: the only way in is
	// an incremental commit, which is this. `hasCommitted` describes the
	// CollectCom that already happened, not eligibility for a deposit.
	if (!head.headIdentifier) {
		throw createHttpError(409, 'Cannot top up before the Hydra head identifier has been observed');
	}

	const cm = getHydraConnectionManager();
	const hydraHead = cm.getHead(head.id);
	if (!hydraHead) throw createHttpError(502, 'No active connection to Hydra head');
	// Same reasoning as the initial commit: a deposit made while the node is
	// still catching up is on chain immediately and unabsorbable until it is not,
	// and its deadline can pass in the meantime.
	await assertNodeReadyForDeposit(localParticipant.id);

	// Hoisted so the outer catch can resolve the row it created: a Preparing row
	// is invisible to reconciliation, which has no deposit hash to look for.
	let preparingTopupId: string | null = null;
	// Set the moment the carve is signed, before it is submitted — see the
	// release guard in this function's `finally`.
	let carveTxHash: string | null = null;
	/**
	 * Set once this operation's own deposit is confirmed on chain.
	 *
	 * That settles the carve too: the deposit spends the carve's output, so a
	 * confirmed deposit is proof the carve landed. Without it the `finally` below
	 * refused to release on an exact-amount top-up whose inline reconcile came
	 * back `confirmed` — no row is left Pending, so no reconciler releases either,
	 * and the wallet sat out the full stale-lock window.
	 */
	let depositConfirmed = false;

	// The `Preparing` claim below serializes top-ups against each other. It says
	// nothing to the payment batchers, which build from this same hot wallet and
	// claim it before they do — so without this a collect and a carve could pick
	// the same UTxO, and the loser's signed transaction would be rejected on
	// chain. Held across the carve's wait for confirmation too: a UTxO spent
	// during that wait is just as gone by the time the commit selects it.
	await claimHotWalletForL1(localParticipant.walletId, 'top-up');

	try {
		let verifiedHead: Awaited<ReturnType<typeof verifyPersistedHydraHeadOnChain>>;
		try {
			verifiedHead = await verifyPersistedHydraHeadOnChain(head.id);
		} catch (verificationError) {
			if (createHttpError.isHttpError(verificationError)) throw verificationError;
			throw createHttpError(502, `Refusing to sign for an unverified Hydra head: ${errorMessage(verificationError)}`);
		}

		const hotWallet = await prisma.hotWallet.findUniqueOrThrow({
			where: { id: localParticipant.walletId },
			include: { Secret: true, PaymentSource: { include: { PaymentSourceConfig: true } } },
		});
		const rpcProviderApiKey = hotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
		if (!rpcProviderApiKey) {
			throw createHttpError(500, 'Payment source has no RPC provider configured for the L1 top-up');
		}

		// Reconcile any prior pending top-up first; only one Pending deposit per
		// participant is permitted, so refuse a new one while an earlier could land.
		// Claimed in one serializable transaction rather than checked and then
		// written. Two requests arriving together would otherwise both find no
		// active top-up and both start a pre-split against the same wallet, which
		// is the same shape of race the node funding had.
		//
		// Preparing counts as active: it holds a carve that is already on chain.
		// A row whose process died mid-carve is aged out here too, since nothing
		// else can resolve one — it has no deposit hash for reconciliation to look
		// for, and it would otherwise block this head's top-ups for good.
		const claim = await withSerializableSlotRetry(() =>
			prisma.$transaction(
				async (tx) => {
					const active = await tx.hydraTopup.findFirst({
						where: {
							hydraLocalParticipantId: localParticipant.id,
							status: { in: [HydraTopupStatus.Preparing, HydraTopupStatus.Pending] },
						},
						orderBy: { createdAt: 'desc' },
					});

					if (active !== null) {
						const isStalePreparation =
							active.status === HydraTopupStatus.Preparing &&
							Date.now() - active.createdAt.getTime() > PREPARING_STALE_AFTER_MS;
						if (!isStalePreparation) {
							return { claimed: false as const, active };
						}
						await tx.hydraTopup.updateMany({
							where: { id: active.id, status: HydraTopupStatus.Preparing },
							data: { status: HydraTopupStatus.Failed },
						});
						logger.warn(`[HydraAPI] Failed a stale preparing top-up ${active.id} so a new one can start`);
					}

					const created = await tx.hydraTopup.create({
						data: {
							hydraHeadId: head.id,
							hydraLocalParticipantId: localParticipant.id,
							// Known only for an exact amount. A whole-UTxO top-up commits
							// whatever the selection turns out to hold, so it stays 0 until
							// promotion and the UI says so rather than showing a total of zero.
							committedLovelace: params.exact?.unit === 'lovelace' ? BigInt(params.exact.amount) : 0n,
							committedAssets:
								params.exact && params.exact.unit !== 'lovelace'
									? { [params.exact.unit]: params.exact.amount.toString() }
									: {},
							status: HydraTopupStatus.Preparing,
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
				claim.active.status === HydraTopupStatus.Preparing
					? 'A prior Hydra top-up is still being prepared on L1'
					: 'A prior Hydra top-up remains pending independent L1 confirmation',
			);
		}
		preparingTopupId = claim.id;

		const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(hotWallet.PaymentSource.network));
		if (!slotConfig) throw createHttpError(500, 'Hydra L1 slot configuration is incomplete or invalid');

		const { wallet, address, utxos, vKey, blockchainProvider } = await generateWalletExtended(
			hotWallet.PaymentSource.network,
			rpcProviderApiKey,
			hotWallet.Secret.encryptedMnemonic,
		);
		if (utxos.length === 0) throw createHttpError(400, 'Local participant wallet has no L1 UTxOs available to top up');

		// Exact-amount top-up: carve a dedicated UTxO on L1 first (pre-split), then
		// commit exactly that UTxO. Otherwise select whole UTxOs (optionally bounded).
		let walletUtxos = utxos;
		let commitUtxos;
		if (params.exact) {
			let carved;
			try {
				carved = await carveExactUtxo({
					wallet,
					blockchainProvider,
					walletAddress: address,
					unit: params.exact.unit,
					amount: params.exact.amount,
					network: hotWallet.PaymentSource.network,
					rpcProviderApiKey,
					existingUtxos: utxos,
					// So the row an operator is watching names the transaction that
					// took their funds, rather than saying only that something is
					// happening.
					onCarveSubmitted: async (splitTxHash) => {
						carveTxHash = splitTxHash;
						await prisma.hydraTopup.update({ where: { id: claim.id }, data: { splitTxHash } });
					},
				});
			} catch (error) {
				if (error instanceof HydraPreSplitError) throw createHttpError(502, `Pre-split failed: ${error.message}`);
				throw error;
			}
			// Refresh the wallet view so the input-safety snapshot reflects the carve.
			walletUtxos = await wallet.getUtxos();
			commitUtxos = [carved];
		} else {
			const selection = params.target
				? selectCommitUtxosUpToTarget(utxos, params.filter, params.target)
				: selectCommitUtxos(utxos, params.filter);
			commitUtxos = selection.commitUtxos;
			if (commitUtxos.length === 0) {
				const describedFilter =
					params.filter === 'ada-only'
						? 'hold only lovelace'
						: params.filter === 'all'
							? 'are plain outputs'
							: `hold ${params.filter.unit}`;
				throw createHttpError(
					400,
					`No wallet UTxOs that ${describedFilter} are available for this top-up. Fund the wallet, or split an existing UTxO, so one large enough to cover the amount exists`,
				);
			}
		}

		let validatedDraft: Awaited<ReturnType<typeof buildValidatedHydraCommit>>;
		try {
			validatedDraft = await buildValidatedHydraCommit({
				commitUtxos,
				walletUtxos,
				walletPaymentKeyHash: vKey,
				expectedHeadId: verifiedHead.headIdentifier,
				slotConfig,
				deps: buildHydraCommitFlowDeps({
					hydraHead,
					wallet,
					blockchainProvider,
					walletId: localParticipant.walletId,
				}),
			});
		} catch (flowError) {
			if (flowError instanceof HydraCommitFlowError) {
				throw createHttpError(502, `Refusing unsafe Hydra top-up draft: ${flowError.message}`);
			}
			throw flowError;
		}

		const committedLovelace = validatedDraft.committedValue.get('lovelace') ?? 0n;
		const committedAssets: Record<string, string> = {};
		for (const [unit, quantity] of validatedDraft.committedValue) {
			if (unit !== 'lovelace') committedAssets[unit] = quantity.toString();
		}

		let submitResult: unknown;
		let topupId: string;
		try {
			({ topupId, submitResult } = await reserveAndSubmitHydraTopup(
				{
					topupId: claim.id,
					hydraHeadId: head.id,
					hydraLocalParticipantId: localParticipant.id,
					depositTxHash: validatedDraft.txId,
					invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
					committedLovelace,
					committedAssets,
				},
				async () =>
					await hydraHead.cardanoTransaction(
						{ type: HydraTransactionType.TxConwayEra, description: '', cborHex: validatedDraft.signedCommitTx },
						localParticipant.walletId,
					),
			));
		} catch (error) {
			if (error instanceof HydraTopupReservationConflictError) throw createHttpError(409, error.message);
			throw error;
		}

		const interpreted = interpretCardanoTxSubmitResult(submitResult);
		const reconciliation = await reconcilePendingHydraTopup({
			id: topupId,
			status: 'Pending',
			depositTxHash: validatedDraft.txId,
			invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
			network: hotWallet.PaymentSource.network,
			rpcProviderApiKey,
		});

		depositConfirmed = reconciliation === 'confirmed';

		if (!interpreted.ok && reconciliation !== 'confirmed') {
			throw createHttpError(
				502,
				`Hydra node rejected the top-up tx submission; L1 reconciliation remains pending: ${interpreted.reason}`,
			);
		}

		await prisma.hydraHead.update({ where: { id: head.id }, data: { latestActivityAt: new Date() } });
		logger.info(`[HydraAPI] Top-up deposit submitted for head ${head.id}`, {
			topupId,
			depositTxHash: validatedDraft.txId,
			confirmed: reconciliation === 'confirmed',
		});

		return {
			headId: head.id,
			topupId,
			depositTxHash: validatedDraft.txId,
			confirmed: reconciliation === 'confirmed',
			committedLovelace,
			committedAssets,
		};
	} catch (error) {
		// Nothing else will resolve this row: reconciliation skips a top-up with no
		// deposit hash, because there is no transaction to look for. Left alone it
		// would spin as Preparing forever and keep the balance panel claiming a
		// deposit was on its way.
		if (preparingTopupId !== null) {
			await prisma.hydraTopup
				.updateMany({
					where: { id: preparingTopupId, status: HydraTopupStatus.Preparing },
					data: { status: HydraTopupStatus.Failed },
				})
				.catch((markError: unknown) => {
					logger.error(`[HydraAPI] Could not fail the preparing top-up ${preparingTopupId}`, { error: markError });
				});
		}
		await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Topup');
		throw error;
	} finally {
		// Held while a deposit of ours is still unconfirmed on L1: the call returns
		// on submission, and the inputs it spends read as unspent from Blockfrost
		// until it lands, so a batcher that took the wallet here would build a
		// second transaction over the same input. `reconcilePendingHydraTopups`
		// releases it once the deposit confirms or fails.
		const pending = await prisma.hydraTopup.findFirst({
			where: {
				hydraLocalParticipantId: localParticipant.id,
				status: { in: [HydraTopupStatus.Pending, HydraTopupStatus.Preparing] },
			},
			select: { id: true },
		});
		// A carve that was signed is a transaction that may be in the mempool, and
		// a failure here says nothing about that: the carve is submitted first and
		// everything after it — waiting for its confirmation, building the deposit
		// — can fail with the carve still on its way. Until it settles, the inputs
		// it spends read as unspent, so handing the wallet back here let the next
		// batch tick build over them and lose one of the two to `BadInputsUTxO`.
		// Nothing tracks a carve after this returns, so the lock is left for the
		// stale-lock sweep, which frees it half an hour later.
		if (pending === null && (carveTxHash === null || depositConfirmed)) {
			await releaseHotWalletAfterL1(localParticipant.walletId);
		}
	}
}
