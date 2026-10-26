/**
 * The head lifecycle: init.
 *
 * Split from the head route module, which was past the 750-line limit; close
 * and fanout moved on to `settlement.ts` when this file reached it in turn, and
 * commit to `commit.ts` after that. Init changes a head's on-chain state, and
 * it carries the reasoning for that irreversible command.
 *
 * Depends on the route module rather than the other way round. The shared
 * verification helpers stay there because the read paths need them too, so the
 * barrel and the docs module import this endpoint from here directly and no
 * cycle forms.
 */

import { HydraErrorType, HydraHeadStatus, HydraInviteRole } from '@/generated/prisma/client';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';

import {
	HydraCommandRefusedUnsyncedError,
	HydraCommandRejectedError,
	HydraPostTxRejectedError,
	HydraHeadInitObservationError,
	HydraProtocolError,
	HydraTransportAmbiguousError,
	HydraTransportError,
} from '@/lib/hydra';
import { assertSafeInitLedgerParams } from '@/services/hydra-host/init-ledger-admission';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { recordHeadError } from '@/services/hydra-head-error/record';
import { readParticipantNodeState } from '@/services/hydra-host/node-state';
import { classifyInitObservation, type InitObservationVerdict } from '@/utils/hydra/init-observation';

import { nodeFailedBeforeInit } from './init-node-failure';
import { forgetHeadFailedClosed } from '@/services/hydra-connection-manager/head-auto-disable-recovery';
import { getErrorMessage, verifyPersistedHydraHeadOnChain } from './index';
import { assertHydraHeadHostNotPaused } from '@/services/hydra-host/pause';
import { assertNoParkedInit, initsAwaitingNode, initsInFlight } from './init-guard';

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
			include: {
				LocalParticipant: true,
				Invite: { select: { role: true } },
				HydraRelation: {
					select: {
						network: true,
						LocalHotWallet: {
							select: { PaymentSource: { select: { PaymentSourceConfig: { select: { rpcProviderApiKey: true } } } } },
						},
					},
				},
			},
		});

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		if (!head.isEnabled) {
			throw createHttpError(409, 'Cannot init a disabled Hydra head');
		}
		await assertHydraHeadHostNotPaused(head.id);

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

		// hydra-node refuses a second Init with a CommandFailed that names no request, so it
		// fails every waiting Init, the one that started the head too. No await between this
		// check and the add, so two requests cannot both pass. Thrown before the try: a
		// refusal is not a failed command.
		if (initsInFlight.has(head.id)) {
			throw createHttpError(409, 'Hydra head init is already in progress');
		}
		initsInFlight.add(head.id);
		// Read before the check, which clears the hold once it passes.
		const wasAwaitingNode = initsAwaitingNode.has(head.id);
		// Checked while holding the slot, so no other init can park a new Init meanwhile.
		try {
			await assertNoParkedInit(head.id, head.LocalParticipant.id);
		} catch (error) {
			initsInFlight.delete(head.id);
			throw error;
		}

		try {
			try {
				await cm.connect(head);
			} catch (error) {
				if (!(error instanceof HydraTransportError)) throw error;
				// A closed live session wraps its reason, so a protocol fault before Greetings arrives as a
				// transport error. Throw the fault itself, so the head error names it.
				if (error.cause instanceof HydraProtocolError) throw error.cause;
				throw nodeFailedBeforeInit(head.id, "Could not reach this head's Hydra node", error);
			}
			const hydraHead = cm.getHead(head.id);
			if (!hydraHead) {
				logger.warn('[HydraAPI] no live session after connect before Init', { hydraHeadId: head.id });
				throw createHttpError(502, 'Failed to connect to Hydra node', { expose: true });
			}
			// The last point before a head exists. Compare the node's raw L2
			// parameters with current L1 values before it can create outputs that
			// fanout cannot move. The parsed provider response pins some fields.
			let ledgerParams: unknown;
			try {
				ledgerParams = await hydraHead.mainNode.get<unknown>('/protocol-parameters');
			} catch (error) {
				// A non-JSON answer or a rotation latch needs a fix, not a retry, so the head error records it.
				if (error instanceof HydraProtocolError) throw error;
				throw nodeFailedBeforeInit(head.id, "Could not read the L2 ledger parameters from this head's node", error);
			}
			await assertSafeInitLedgerParams({
				ledgerParams,
				network: head.HydraRelation.network,
				rpcProviderApiKey: head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey,
			});

			// True on the normal path and cleared when the timeout diagnosis has
			// already drained frames, so the drain below runs exactly once per path.
			let needsPostInitFlush = true;
			try {
				await hydraHead.init();
			} catch (initError) {
				// The node said it dropped this Init because it is behind the chain. That
				// is an answer, not a timeout: nothing was posted, so it is no failed
				// command and needs no diagnosis or head error. An earlier Init held for
				// this head may still be parked, so that hold stays.
				if (initError instanceof HydraCommandRefusedUnsyncedError) {
					if (wasAwaitingNode) initsAwaitingNode.add(head.id);
					throw createHttpError(
						503,
						`${initError.message}. Init was not posted; send it again once the node has caught up.`,
						{ expose: true },
					);
				}
				// A failed InitTx post is not a timeout: the node answered, so no Init
				// is parked or racing and there is nothing to diagnose. This row is the
				// failure's only record; the connection manager leaves a failure that a
				// waiting command reports to that command. A CommandFailed still goes
				// through the diagnosis below: the node also sends it for a head that
				// has already initialized, which is no failure.
				if (initError instanceof HydraPostTxRejectedError) {
					await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, initError, 'Init');
					throw createHttpError(504, initError.message, { expose: true });
				}
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
					// A CommandFailed is the node refusing this Init, so nothing was
					// posted and "wait, do not re-post" would be false. Only a head seen
					// moving clears it.
					if (verdict.kind === 'awaiting-node' && initError instanceof HydraCommandRejectedError) {
						verdict = { kind: 'failed' };
					}
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
					initsAwaitingNode.add(head.id);
					throw createHttpError(504, verdict.message, { expose: true });
				}
				if (verdict.kind === 'failed') {
					// Leave the head Idle (no state regression) and return an actionable
					// 504 so the operator retries rather than seeing a generic hang/500.
					// Only the node's answer and the outcome timeouts are fixed text; a
					// transport error can name an internal host, so it stays in the head
					// error row and the caller gets the generic message.
					await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, initError, 'Init');
					const isCallerSafe =
						initError instanceof HydraCommandRejectedError || initError instanceof HydraTransportAmbiguousError;
					throw createHttpError(504, isCallerSafe ? initError.message : 'Init did not confirm on-chain in time', {
						expose: true,
					});
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
				forgetHeadFailedClosed(head.id);
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
		} finally {
			initsInFlight.delete(head.id);
		}
	},
});
