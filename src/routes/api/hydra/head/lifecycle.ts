/**
 * The head lifecycle: init, commit, close, fanout.
 *
 * Split from the head route module, which was past the 750-line limit. These
 * four are the endpoints that change a head's on-chain state, and they are the
 * reason the file was large: each carries the reasoning for an irreversible
 * command.
 *
 * Depends on the route module rather than the other way round. The shared
 * verification helpers stay there because the read paths need them too, so the
 * barrel and the docs module import these endpoints from here directly and no
 * cycle forms.
 */

import { HydraErrorType, HydraHeadStatus, HydraInviteRole, HydraTopupStatus } from '@/generated/prisma/client';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';

import {
	buildValidatedHydraCommit,
	type ValidatedHydraCommit,
	HydraCommitFlowError,
	HydraHeadInitObservationError,
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
import { readParticipantNodeState } from '@/services/hydra-host/node-state';
import { carveExactUtxo, HydraPreSplitError } from '@/services/hydra-topup/pre-split';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { classifyInitObservation, type InitObservationVerdict } from '@/utils/hydra/init-observation';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';

import { buildHydraCommitFlowDeps } from './commit-flow-deps';
import { assertNodeReadyForDeposit, getErrorMessage, verifyPersistedHydraHeadOnChain } from './index';

// --- Lifecycle: POST init ---

export const lifecycleInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

export const lifecycleOutput = z.object({
	headId: z.string(),
	status: z.nativeEnum(HydraHeadStatus),
});

export const initHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: lifecycleInput,
	output: lifecycleOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			include: { LocalParticipant: true, Invite: { select: { role: true } } },
		});

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		if (!head.isEnabled) {
			throw createHttpError(409, 'Cannot init a disabled Hydra head');
		}

		// Exactly one side may open a head, and nothing in the protocol arbitrates
		// it: two Inits race for the same seed inputs, one loses on chain, and the
		// loser's head is left Initializing against a head that does not exist.
		// The redeemer is the one that opens, because it is the side that acted
		// last and therefore knows the exchange completed — the issuer only learns
		// that by polling, so it could not tell "not yet redeemed" from "redeemed
		// and already opened".
		if (head.Invite?.role === HydraInviteRole.Issuer) {
			throw createHttpError(
				409,
				'This head is opened by the counterparty who redeemed your invite, not from here. ' +
					'It moves to Initializing on its own once they post the Init transaction.',
			);
		}

		if (head.status !== HydraHeadStatus.Idle) {
			throw createHttpError(409, `Cannot init: head status is ${head.status}, expected Idle`);
		}

		if (!head.LocalParticipant) {
			throw createHttpError(400, 'Head has no local participant');
		}

		const cm = getHydraConnectionManager();

		try {
			await cm.connect(head);
			const hydraHead = cm.getHead(head.id);
			if (!hydraHead) {
				throw createHttpError(502, 'Failed to connect to Hydra node');
			}

			// True on the normal path and cleared when the timeout diagnosis has
			// already drained frames, so the drain below runs exactly once per path.
			let needsPostInitFlush = true;
			try {
				await hydraHead.init();
			} catch (initError) {
				// A bounded init that never observed HeadIsInitializing has two very
				// different causes, and the timeout alone cannot tell them apart: the
				// chain backend silently dropped the InitTx and the node is wedged, or
				// the node is behind and has not reached that block yet. Ask the node
				// where it thinks it is before blaming it.
				//
				// The whole diagnosis is guarded. It drains frames, reads the row and
				// asks the Host, and a failure in any of those must never swallow the
				// original init error or surface as a 500: diagnosis cannot be allowed
				// to fail louder than the thing it diagnoses. Anything that throws here
				// falls back to the conclusion this branch drew before it existed.
				let verdict: InitObservationVerdict;
				try {
					// Drained first, because a frame that arrived while init was giving
					// up makes this no failure at all.
					await cm.flushHeadStatus(head.id);
					const [observed, nodeState] = await Promise.all([
						prisma.hydraHead.findUnique({ where: { id: head.id }, select: { status: true } }),
						readParticipantNodeState(head.LocalParticipant.id),
					]);
					verdict = classifyInitObservation({
						headStatus: observed?.status ?? head.status,
						chainSynced: nodeState.chainSynced,
						driftSeconds: nodeState.driftSeconds,
					});
					if (verdict.kind === 'observed') {
						logger.info('[Hydra] Init was observed after the wait ran out; head is already moving', {
							hydraHeadId: head.id,
							status: observed?.status,
						});
					} else if (verdict.kind === 'awaiting-node') {
						logger.warn(`[Hydra] ${verdict.message}`, {
							hydraHeadId: head.id,
							driftSeconds: nodeState.driftSeconds,
						});
					}
				} catch (diagnosisError) {
					logger.warn('[Hydra] Could not diagnose an Init timeout; treating it as a failure', {
						hydraHeadId: head.id,
						diagnosisError: getErrorMessage(diagnosisError),
					});
					verdict = { kind: 'failed' };
				}

				if (verdict.kind === 'awaiting-node') {
					// No head error recorded: nothing failed, and a CommandFailed here
					// is exactly the self-resolving error that teaches operators to
					// disregard the ones that matter. The message tells the operator not
					// to re-post, since two Inits race for the same seed input.
					throw createHttpError(504, verdict.message);
				}
				if (verdict.kind === 'failed') {
					// Leave the head Idle (no state regression) and return an actionable
					// 504 so the operator retries rather than seeing a generic hang/500.
					await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, initError, 'Init');
					throw createHttpError(
						504,
						initError instanceof Error ? initError.message : 'Init did not confirm on-chain in time',
					);
				}
				// observed: fall through to the normal post-init flow, already drained.
				needsPostInitFlush = false;
			}

			// Hydra 2.3 can advance directly to Open before init() resolves. Drain
			// observed status frames and return the durable state instead of blindly
			// regressing it to Initializing.
			if (needsPostInitFlush) await cm.flushHeadStatus(head.id);
			try {
				await verifyPersistedHydraHeadOnChain(head.id);
			} catch (verificationError) {
				if (verificationError instanceof HydraHeadInitObservationError) {
					// The Init command is irreversible, while the independent index is
					// eventually consistent. Keep the authenticated node session alive and
					// quarantine L2 routing via the still-null initTxHash until a later
					// commit/lifecycle verification observes the InitTx.
					throw createHttpError(
						503,
						`Hydra head initialized, but independent L1 evidence is not available yet: ${getErrorMessage(verificationError)}`,
					);
				}
				// An initialized-but-unverified head must not remain eligible for sync or
				// lifecycle actions. Re-enabling is an explicit operator decision after
				// fixing the L1 observer or node configuration.
				await prisma.hydraHead.updateMany({ where: { id: head.id }, data: { isEnabled: false } });
				await cm.disconnect(head.id);
				throw createHttpError(
					502,
					`Hydra InitTx configuration could not be verified independently: ${getErrorMessage(verificationError)}`,
				);
			}
			const persistedHead = await prisma.hydraHead.findUnique({
				where: { id: head.id },
				select: { status: true },
			});
			if (!persistedHead) throw createHttpError(404, 'Hydra head not found');

			logger.info(`[HydraAPI] Head ${head.id} initialized`, { status: persistedHead.status });
			return { headId: head.id, status: persistedHead.status };
		} catch (error) {
			if (createHttpError.isHttpError(error)) {
				throw error;
			}
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Init');
			throw error;
		}
	},
});

// --- Lifecycle: POST commit (local participant only) ---

export const commitInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
	lovelace: z
		.string()
		.regex(/^\d+$/)
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

		if (head.status !== HydraHeadStatus.Initializing && head.status !== HydraHeadStatus.Open) {
			throw createHttpError(409, `Cannot commit: head status is ${head.status}, expected Initializing or Open`);
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

		try {
			let verifiedHead: Awaited<ReturnType<typeof verifyPersistedHydraHeadOnChain>>;
			try {
				verifiedHead = await verifyPersistedHydraHeadOnChain(head.id);
			} catch (verificationError) {
				if (createHttpError.isHttpError(verificationError)) throw verificationError;
				throw createHttpError(
					502,
					`Refusing to sign for an unverified Hydra head: ${getErrorMessage(verificationError)}`,
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

			// Submit the signed commit tx through the hydra-node connected to the
			// head's L1. Promotion still requires independent Blockfrost evidence;
			// private devnets therefore need a separately trusted L1 observer and
			// otherwise remain fail-closed until the signed validity window expires.
			let submitResult: unknown;
			try {
				submitResult = await reserveAndSubmitHydraCommit(
					{
						participantId: localParticipant.id,
						commitTxHash,
						invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
					},
					async () =>
						await hydraHead.cardanoTransaction(
							{
								type: HydraTransactionType.TxConwayEra,
								description: '',
								cborHex: signedCommitTx,
							},
							localParticipant.walletId,
						),
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
		}
	},
});
