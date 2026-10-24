/**
 * Committing funds into a head from the local participant.
 *
 * Split from `lifecycle.ts`, which was past the 750-line limit. Moved
 * unchanged; the reasoning for each step stays with the code.
 */

import { HydraErrorType, HydraHeadStatus, HydraTopupStatus } from '@/generated/prisma/client';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';

import {
	buildValidatedHydraCommit,
	type ValidatedHydraCommit,
	HydraCommitFlowError,
	HydraTransactionType,
	interpretCardanoTxSubmitResult,
} from '@/lib/hydra';
import {
	HydraCommitReservationConflictError,
	reconcilePendingHydraCommit,
	reserveAndSubmitHydraCommit,
	type HydraCommitReconciliationResult,
} from '@/services/hydra-commit-reconciliation';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { recordHeadError } from '@/services/hydra-head-error/record';
import { describeErrorForOperator } from '@/services/hydra-head-error/operator-message';
import { carveExactUtxo, HydraPreSplitError } from '@/services/hydra-topup/pre-split';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';

import { buildHydraCommitFlowDeps } from './commit-flow-deps';
import { assertNodeReadyForDeposit, verifyPersistedHydraHeadOnChain } from './index';
import { claimHotWalletForL1, releaseHotWalletAfterL1 } from '@/utils/db/hot-wallet-lock';
import {
	DATABASE_AMOUNT_MESSAGE,
	POSITIVE_BASE_UNIT_AMOUNT,
	POSITIVE_BASE_UNIT_AMOUNT_MESSAGE,
	withinDatabaseAmount,
} from '@/routes/api/hydra/head/amounts';
import { assertHydraHeadHostNotPaused } from '@/services/hydra-host/pause';

// --- Lifecycle: POST commit (local participant only) ---

export const commitInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
	lovelace: z
		.string()
		.regex(POSITIVE_BASE_UNIT_AMOUNT, POSITIVE_BASE_UNIT_AMOUNT_MESSAGE)
		.refine(withinDatabaseAmount, DATABASE_AMOUNT_MESSAGE)
		.describe(
			"How much to put into the head. A dedicated UTxO of exactly this amount is carved on L1 first and only that is committed, so the rest of the wallet — its other ADA, its stablecoins, an agent's registry NFT — stays on L1 and spendable. Costs one L1 confirmation before the deposit is built.",
		),
});

export const commitOutput = z.object({
	headId: z.string(),
	committed: z.boolean(),
	commitTxHash: z.string().nullable(),
});

export const commitHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: commitInput,
	output: commitOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			include: { LocalParticipant: true },
		});

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		if (!head.isEnabled) {
			throw createHttpError(409, 'Cannot commit to a disabled Hydra head');
		}
		await assertHydraHeadHostNotPaused(head.id);

		// Open only. hydra-node accepts a commit while a head is Initializing too,
		// but that draft spends the vInitial output with a Plutus redeemer, so it
		// carries a script_data_hash and pays into the head script rather than the
		// deposit script — and `validateHydraCommitDraft` refuses both. The request
		// could therefore never succeed, yet it got that far only AFTER
		// `carveExactUtxo` had submitted a real L1 transaction: the operator paid a
		// fee for nothing, and the `finally` below deliberately holds the hot
		// wallet for the full stale-lock window because a carve is unsettled,
		// locking the batchers out of that participant's wallet for half an hour.
		//
		// Refused here instead, before anything is spent. Every head this service
		// opens opens empty and is funded by deposit; see docs/hydra-architecture.md.
		if (head.status !== HydraHeadStatus.Open) {
			throw createHttpError(
				409,
				head.status === HydraHeadStatus.Initializing
					? 'Cannot commit while the head is still Initializing: funds enter an open head as a deposit, so wait for both parties to open it and then top up'
					: `Cannot commit: head status is ${head.status}, expected Open`,
			);
		}

		// Rechecked under the head lock at reservation; refused here too so a
		// closing head costs no carve.
		if (head.isClosing) {
			throw createHttpError(409, 'Cannot commit: Hydra head close is in progress');
		}

		const localParticipant = head.LocalParticipant;
		if (!localParticipant) {
			throw createHttpError(400, 'Head has no local participant');
		}

		if (localParticipant.hasCommitted) {
			throw createHttpError(409, 'Local participant has already committed');
		}
		if (!head.headIdentifier) {
			throw createHttpError(409, 'Cannot commit before the Hydra head identifier has been observed');
		}

		const cm = getHydraConnectionManager();
		const hydraHead = cm.getHead(head.id);
		if (!hydraHead) {
			throw createHttpError(502, 'No active connection to Hydra head');
		}
		await assertNodeReadyForDeposit(localParticipant.id);

		// A commit spends the participant's own hot wallet on L1, and that wallet is
		// an ordinary selling or purchasing wallet the payment batchers also build
		// from. They claim it before they build; this did not, so a collect and a
		// commit could choose the same UTxO and one of them would be rejected on
		// chain after being signed and submitted. Held until the commit is away,
		// including across the carve's own wait for confirmation.
		const walletClaimToken = await claimHotWalletForL1(localParticipant.walletId, 'commit');
		// Set the moment the carve is signed, before it is submitted — see the
		// release guard in this handler's `finally`.
		let carveTxHash: string | null = null;
		try {
			let verifiedHead: Awaited<ReturnType<typeof verifyPersistedHydraHeadOnChain>>;
			try {
				verifiedHead = await verifyPersistedHydraHeadOnChain(head.id);
			} catch (verificationError) {
				if (createHttpError.isHttpError(verificationError)) throw verificationError;
				throw createHttpError(
					502,
					`Refusing to sign for an unverified Hydra head: ${describeErrorForOperator(verificationError)}`,
				);
			}
			// Load the local participant's hot wallet + its L1 provider so we can
			// fund the head with REAL UTxOs. A commit must spend the committing
			// wallet's L1 UTxOs and be signed + submitted to L1 (the hydra-node only
			// returns an unsigned draft). An empty commit opens a head with no
			// funds, which no escrow lock can ever spend.
			const hotWallet = await prisma.hotWallet.findUniqueOrThrow({
				where: { id: localParticipant.walletId },
				include: { Secret: true, PaymentSource: { include: { PaymentSourceConfig: true } } },
			});
			const rpcProviderApiKey = hotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!rpcProviderApiKey) {
				throw createHttpError(500, 'Payment source has no RPC provider configured for the L1 commit');
			}

			const reconcileCommit = async (): Promise<HydraCommitReconciliationResult> =>
				await reconcilePendingHydraCommit({
					id: localParticipant.id,
					hasCommitted: localParticipant.hasCommitted,
					commitTxHash: localParticipant.commitTxHash,
					commitInvalidHereafterSlot: localParticipant.commitInvalidHereafterSlot,
					commitWalletClaimToken: localParticipant.commitWalletClaimToken,
					network: hotWallet.PaymentSource.network,
					rpcProviderApiKey,
				});

			// A prior request may have lost the Hydra submit response or died after
			// broadcast. Never sign a replacement while that exact TTL-bearing body
			// can still land. Resolve it against trusted L1 evidence first.
			if (localParticipant.commitTxHash != null || localParticipant.commitInvalidHereafterSlot != null) {
				const reconciliation = await reconcileCommit();
				if (reconciliation === 'confirmed') {
					return {
						headId: head.id,
						committed: true,
						commitTxHash: localParticipant.commitTxHash,
					};
				}
				if (reconciliation !== 'cleared' && reconciliation !== 'none') {
					const status = reconciliation === 'transient-error' ? 503 : 409;
					throw createHttpError(
						status,
						reconciliation === 'malformed'
							? 'Pending Hydra commit evidence is incomplete; refusing an unsafe retry'
							: 'A prior Hydra commit remains pending independent L1 confirmation',
					);
				}
			}

			const { wallet, utxos, vKey, blockchainProvider } = await generateWalletExtended(
				hotWallet.PaymentSource.network,
				rpcProviderApiKey,
				hotWallet.Secret.encryptedMnemonic,
			);
			if (utxos.length === 0) {
				throw createHttpError(400, 'Local participant wallet has no L1 UTxOs available to commit');
			}

			// Datum and reference-script outputs cannot be represented faithfully by
			// the commit codec, so only plain pubkey UTxOs may be committed. Under the
			// decoupled node-key model the hydra-node funds the deposit's L1 fee,
			// collateral and change from its OWN dedicated cardano key (not this
			// participant's funding wallet), so every plain wallet UTxO can be
			// committed and no fee-fuel input needs to be reserved.
			// Carve exactly what was asked for, then commit only that.
			//
			// This used to select UTxOs instead, which made "fund the head" mean
			// "empty the wallet into it": every plain UTxO went, including the one
			// carrying the agent's registry NFT and any stablecoin balance, and
			// nothing inside a head can be spent or updated on L1 until it closes.
			// Filtering to ADA would only have narrowed which things got swept. An
			// amount is what an operator means, and a dedicated UTxO is the only
			// way to commit one, because Hydra commits whole UTxOs.
			let carved;
			try {
				carved = await carveExactUtxo({
					wallet,
					blockchainProvider,
					walletAddress: hotWallet.walletAddress,
					unit: 'lovelace',
					amount: BigInt(input.lovelace),
					network: hotWallet.PaymentSource.network,
					rpcProviderApiKey,
					// A commit that failed after its carve left the amount sitting in
					// the wallet as its own UTxO. Retrying used to carve a second one
					// beside it, at another fee, and leave the first stranded.
					existingUtxos: utxos,
					// Reported as soon as the carve is signed, before it is submitted.
					// The release guard in this handler's `finally` turns on it.
					onCarveSubmitted: async (hash) => {
						carveTxHash = hash;
					},
				});
			} catch (splitError) {
				if (splitError instanceof HydraPreSplitError) {
					throw createHttpError(502, `Could not carve the amount to commit: ${splitError.message}`);
				}
				throw splitError;
			}
			const commitUtxos = [carved];
			// The carve changed the wallet, so the input-safety snapshot has to be
			// taken after it rather than before.
			const walletUtxosAfterCarve = await wallet.getUtxos();

			logger.info(`[HydraAPI] Carved the commit amount for head ${head.id}`, {
				commitUtxoCount: commitUtxos.length,
				committedLovelace: input.lovelace,
			});

			const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(hotWallet.PaymentSource.network));
			if (!slotConfig) {
				throw createHttpError(500, 'Hydra L1 slot configuration is incomplete or invalid');
			}

			// Draft → key-scoped input safety → validate → partial-sign, all against
			// the untrusted node draft. Shared with the repeatable top-up endpoint.
			let validatedDraft: ValidatedHydraCommit;
			try {
				validatedDraft = await buildValidatedHydraCommit({
					commitUtxos,
					walletUtxos: walletUtxosAfterCarve,
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
					throw createHttpError(502, `Refusing unsafe Hydra commit draft: ${flowError.message}`);
				}
				throw flowError;
			}
			const signedCommitTx = validatedDraft.signedCommitTx;
			const commitTxHash = validatedDraft.txId;
			// The carve and draft can outlive a healthy supervisor observation.
			// Check again before reserving, so a known refusal creates no pending commit.
			await assertNodeReadyForDeposit(localParticipant.id);

			// Submit the signed commit tx through the hydra-node connected to the
			// head's L1. Promotion still requires independent Blockfrost evidence;
			// private devnets therefore need a separately trusted L1 observer and
			// otherwise remain fail-closed until the signed validity window expires.
			let submitResult: unknown;
			try {
				submitResult = await reserveAndSubmitHydraCommit(
					{
						participantId: localParticipant.id,
						hydraHeadId: head.id,
						commitTxHash,
						invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
						walletClaimToken,
					},
					async () => {
						// The reservation transaction can also wait on a row lock.
						await assertNodeReadyForDeposit(localParticipant.id);
						return await hydraHead.cardanoTransaction(
							{
								type: HydraTransactionType.TxConwayEra,
								description: '',
								cborHex: signedCommitTx,
							},
							localParticipant.walletId,
						);
					},
				);
			} catch (error) {
				if (error instanceof HydraCommitReservationConflictError) {
					throw createHttpError(409, error.message);
				}
				throw error;
			}

			// Record the commit as a deposit, the same way a top-up is recorded.
			//
			// A commit IS an incremental commit — same deposit script, same period,
			// same deadline — but only top-ups were being written down. So the very
			// first funding of a head was the one an operator could neither see in
			// the deposits list nor recover when the head failed to absorb it, which
			// is exactly the deposit most likely to expire: it is made while the node
			// is still catching up on chain. Writing it here gives it the list entry
			// and the Recover button every later deposit already had.
			const committedLovelace = validatedDraft.committedValue.get('lovelace') ?? 0n;
			const committedAssets: Record<string, string> = {};
			for (const [unit, quantity] of validatedDraft.committedValue) {
				if (unit !== 'lovelace') committedAssets[unit] = quantity.toString();
			}
			const alreadyRecorded = await prisma.hydraTopup.findFirst({
				where: { hydraHeadId: head.id, depositTxHash: commitTxHash },
				select: { id: true },
			});
			if (alreadyRecorded == null) {
				await prisma.hydraTopup
					.create({
						data: {
							hydraHeadId: head.id,
							hydraLocalParticipantId: localParticipant.id,
							depositTxHash: commitTxHash,
							invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
							// Says what this row is, so neither reconciler has to infer it from a
							// hash the participant can later replace by retrying the commit.
							isInitialCommit: true,
							committedLovelace,
							committedAssets,
							status: HydraTopupStatus.Pending,
						},
					})
					.catch((recordError: unknown) => {
						// The commit itself is already submitted and reconciles on its own
						// evidence; failing to write the display row must not fail it.
						logger.warn('[HydraAPI] could not record the commit deposit for display', {
							headId: head.id,
							commitTxHash,
							error: recordError instanceof Error ? recordError.message : recordError,
						});
					});
			}

			// hydra-node replies `{ tag: 'TransactionSubmitted' }` on success or
			// `{ tag: 'FailedToPostTx', failureReason }` on rejection. Fail loudly so
			// the caller knows the commit never reached L1.
			const interpreted = interpretCardanoTxSubmitResult(submitResult);
			const reconciliation = await reconcilePendingHydraCommit({
				id: localParticipant.id,
				hasCommitted: false,
				commitTxHash,
				commitInvalidHereafterSlot: validatedDraft.invalidHereafterSlot,
				commitWalletClaimToken: walletClaimToken,
				network: hotWallet.PaymentSource.network,
				rpcProviderApiKey,
			});
			if (reconciliation === 'confirmed') {
				await prisma.hydraHead.update({
					where: { id: head.id },
					data: { latestActivityAt: new Date() },
				});
				logger.info(`[HydraAPI] Local participant commit confirmed on L1 for head ${head.id}`, { commitTxHash });
				return {
					headId: head.id,
					committed: true,
					commitTxHash,
				};
			}
			if (reconciliation === 'cleared') {
				throw createHttpError(502, 'Hydra commit was absent after its validity deadline; retry is now safe');
			}
			if (!interpreted.ok) {
				// The node's rejection is not independent proof that the transaction was
				// never relayed. Keep the exact hash + TTL reserved for reconciliation.
				throw createHttpError(
					502,
					`Hydra node rejected the commit tx submission; L1 reconciliation remains pending: ${interpreted.reason}`,
				);
			}
			if (reconciliation === 'malformed' || reconciliation === 'none') {
				throw createHttpError(500, 'Hydra commit pending evidence could not be reconciled safely');
			}

			await prisma.hydraHead.update({
				where: { id: head.id },
				data: { latestActivityAt: new Date() },
			});
			logger.info(`[HydraAPI] Local participant commit submitted; awaiting independent L1 confirmation`, {
				headId: head.id,
				commitTxHash,
			});
			return {
				headId: head.id,
				committed: false,
				commitTxHash,
			};
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Commit');
			throw error;
		} finally {
			// Held while a commit of ours is still unconfirmed on L1. The handler
			// returns as soon as the transaction is submitted, and the inputs it
			// spends still read as unspent from Blockfrost until it lands, so a
			// batcher that took the wallet here would build a second transaction
			// over the same input. `reconcilePendingHydraCommits` releases it when
			// the commit confirms or is cleared; the stale-lock window covers the
			// case where nothing ever settles it.
			const pending = await prisma.hydraLocalParticipant.findUnique({
				where: { id: localParticipant.id },
				select: { commitTxHash: true, hasCommitted: true, commitWalletClaimToken: true },
			});
			// The carve is its own L1 transaction, submitted before the commit is
			// even built, and a failure after that point says nothing about where it
			// got to. While it is unsettled its inputs still read as unspent, so
			// handing the wallet back here let the next batch tick build over them
			// and lose one of the two to `BadInputsUTxO`. Nothing tracks a carve
			// once this returns, so the lock is left for the stale-lock sweep half
			// an hour later.
			const carveUnsettled = carveTxHash !== null && !pending?.hasCommitted;
			// A refused retry can leave an EARLIER commit's reservation outstanding.
			// Its reconciler releases with that commit's own token, which no longer
			// matches the claim this request took over, so the wallet would wait for
			// the stale-lock sweep. Hand this claim to that reservation instead: its
			// reconciler then frees the wallet when the earlier commit settles.
			let heldForPendingCommit = pending?.commitTxHash != null && !pending.hasCommitted;
			// Not while our own carve is unsettled: that reconciler would free the
			// wallet when ITS commit settles, with our carve's inputs still in flight.
			if (heldForPendingCommit && !carveUnsettled && pending?.commitWalletClaimToken !== walletClaimToken) {
				const handedOver = await prisma.hydraLocalParticipant
					.updateMany({
						// Fenced on the token read above too: a holder that took the wallet
						// over since then may have handed its own claim over already.
						where: {
							id: localParticipant.id,
							hasCommitted: false,
							commitTxHash: pending?.commitTxHash,
							commitWalletClaimToken: pending?.commitWalletClaimToken,
						},
						data: { commitWalletClaimToken: walletClaimToken },
					})
					.catch((handoverError: unknown) => {
						logger.warn('[HydraAPI] Could not hand the wallet claim to the pending commit', {
							error: handoverError instanceof Error ? handoverError.message : 'Non-error failure',
						});
						return null;
					});
				// Settled in the meantime: nothing is left to hold the wallet for. A
				// failed write keeps the lock and leaves it to the stale-lock sweep.
				if (handedOver?.count === 0) heldForPendingCommit = false;
			}
			if (!heldForPendingCommit && !carveUnsettled) {
				await releaseHotWalletAfterL1(localParticipant.walletId, walletClaimToken);
			}
		}
	},
});
