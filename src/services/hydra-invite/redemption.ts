/**
 * Carrying a recorded redemption through to a head.
 *
 * A redemption is five steps with one that cannot be undone: posting it spends
 * the issuer's single-use nonce. So the redeemer writes its own record first, and
 * everything here is written to be repeated: by the request that started it, by
 * the operator retrying the same code, and by the job that resumes what a crash
 * interrupted. The collaborators are passed in as ports, so each failure point
 * can be exercised directly and nothing here knows about the database.
 *
 * Two rules decide what may be undone. Before the issuer has acknowledged the
 * redemption, the record is deleted or failed only on the cases
 * `classifyRedemptionAttempt` proves. After it, nothing is undone: the nonce is
 * spent and the redemption is owed, so a failure keeps the record and waits.
 */
import createHttpError from 'http-errors';
import type { HostPeer, HostPeerCheck } from '@/services/hydra-host/client';
import { attemptFailure, type ExchangeAttempt } from './exchange-client';

/**
 * What a redemption attempt means for the redeemer's own record.
 *
 * The record is evidence that the issuer's single-use nonce may have been spent
 * on our behalf. Deleting it forgets that, so it is deleted only when nothing
 * can have landed; failing it ends the redemption, so that needs proof the nonce
 * is someone else's. Every other case keeps the record, which costs a held node
 * slot until the operator retries or the cleanup bound passes, where deleting
 * wrongly costs an invite that can never complete.
 */
type RedemptionDecision =
	| { action: 'accepted' }
	/** Nothing landed: delete the record, so the same code can be tried again. */
	| { action: 'discard'; error: createHttpError.HttpError }
	/** The nonce is provably someone else's, or the invite expired unredeemed: end the redemption. */
	| { action: 'fail'; error: createHttpError.HttpError }
	/** It may have landed, or the cause is transient: leave the record as it is. */
	| { action: 'keep'; error: createHttpError.HttpError };

/**
 * Statuses the Host answers before it touches the nonce, or that mean the nonce
 * is not ours. A gateway's 5xx is absent on purpose: it can follow a request the
 * Host fully processed.
 */
const ANSWERED_BEFORE_THE_NONCE_IS_SPENT = new Set([400, 401, 404, 409, 410, 413, 429]);

/**
 * The Host sends 503 while busy or while the reserved node is stopped, both
 * before the nonce. A load balancer sends the same status when its upstream
 * fails mid-request, which can follow a redemption that landed, so a 503 counts
 * only when its body is the Host's own.
 */
const HOST_BUSY_STATUS = 503;

/**
 * `rowIsNew` is true only inside the request that created the record, where
 * there was no earlier attempt. Then any answer from the Host, or no connection
 * at all, shows this attempt did not land. A record found later, by a retry or
 * the resume job, cannot say that about attempts it did not see.
 */
function classifyRedemptionAttempt(attempt: ExchangeAttempt, context: { rowIsNew: boolean }): RedemptionDecision {
	if (attempt.kind === 'accepted') return { action: 'accepted' };
	const error = attemptFailure(attempt);

	if (context.rowIsNew) {
		const nothingLanded =
			attempt.kind === 'not-sent' ||
			(attempt.kind === 'answered' &&
				(ANSWERED_BEFORE_THE_NONCE_IS_SPENT.has(attempt.status) ||
					(attempt.status === HOST_BUSY_STATUS && attempt.fromHost)));
		return { action: nothingLanded ? 'discard' : 'keep', error };
	}

	// 410 never comes from a redeemed record: the Host checks the redemption
	// before the expiry. So it means the invite lapsed unredeemed.
	if (attempt.kind === 'answered' && attempt.status === 410) return { action: 'fail', error };
	if (attempt.kind === 'answered' && attempt.status === 409 && attempt.code === 'redeemed-by-other') {
		return { action: 'fail', error };
	}
	return { action: 'keep', error };
}

/** What the state machine needs to know about the record. */
export type RedemptionState = {
	/** `Redeemed` until the node has its peers and is started, then `Started`. */
	status: 'Redeemed' | 'Started';
	/** The issuer's Host has taken the redemption (`redeemedAt` is set). */
	acknowledged: boolean;
	/** The one peer our node must be configured with. */
	issuerPeer: HostPeer;
	/** Our Host is paused for maintenance and must not have its nodes started or its heads touched. */
	hostPaused: boolean;
};

export type RedemptionPorts = {
	/**
	 * Take hold of an unconfirmed record before posting it again. False when it changed since it was read.
	 * Until a retry has claimed it, the request that created the record may delete it, and the retry
	 * must never be left having spent the nonce with no record behind it.
	 */
	claim(): Promise<boolean>;
	/** Ask our own Host whether it would accept the issuer's peer address. */
	checkPeerTarget(advertise: string): Promise<HostPeerCheck>;
	/** Throw if another redemption with the same counterparty is pending or a head exists. */
	assertNoCompetingRedemption(): Promise<void>;
	/** Send the signed redemption to the issuer's Host. */
	post(): Promise<ExchangeAttempt>;
	/**
	 * Record the acknowledgement and return how far the record has got, which a concurrent caller may
	 * have taken further. Null when the record is gone or ended.
	 */
	markAcknowledged(): Promise<'Redeemed' | 'Started' | 'Completed' | null>;
	/** Delete a record that never landed. */
	discard(): Promise<void>;
	/**
	 * End a redemption that can never complete. False when it was not in a state to end. Its node is
	 * released later by the abandoned-reservation sweep, once the record no longer shields it.
	 */
	fail(): Promise<boolean>;
	currentPeers(): Promise<HostPeer[]>;
	setPeers(peers: HostPeer[]): Promise<void>;
	start(): Promise<void>;
	/** Record that the node is configured and started. A lost race is harmless. */
	markStarted(): Promise<boolean>;
	/** Create the head and link the record to it in one transaction. */
	createHead(): Promise<{ hydraHeadId: string }>;
	/** The record as it is now. */
	reload(): Promise<{ status: string; hydraHeadId: string | null } | null>;
};

export type AdvanceOptions = {
	/** True only inside the request that created the record: no earlier attempt can have landed. */
	rowIsNew: boolean;
};

function samePeers(current: HostPeer[], wanted: HostPeer): boolean {
	return (
		current.length === 1 &&
		current[0].advertise === wanted.advertise &&
		current[0].hydraVerificationKey === wanted.hydraVerificationKey &&
		current[0].cardanoVerificationKey === wanted.cardanoVerificationKey
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Past the acknowledgement a failure is the Host's or the database's, never a reason to undo anything. */
function unfinished(error: unknown): createHttpError.HttpError {
	return createHttpError(
		502,
		`the issuer accepted the redemption, but finishing it here failed (${errorMessage(error)}); it will complete automatically`,
	);
}

async function acknowledge(
	state: RedemptionState,
	ports: RedemptionPorts,
	options: AdvanceOptions,
): Promise<'Redeemed' | 'Started' | 'Completed'> {
	if (!options.rowIsNew) {
		// Before anything is sent. The request that created this record deletes it
		// when the Host refuses it, and a retry that posted without claiming could
		// have its redemption accepted just after that, with no record left.
		if (!(await ports.claim())) {
			throw createHttpError(409, 'this redemption changed while it was being retried; retry the same invite code');
		}
		await ports.assertNoCompetingRedemption();
	}

	// Everything our own Host can refuse is asked before the nonce is spent, so a
	// private or unresolvable peer address never burns an invite.
	let check: HostPeerCheck;
	try {
		check = await ports.checkPeerTarget(state.issuerPeer.advertise);
	} catch (error) {
		if (options.rowIsNew) await ports.discard();
		throw createHttpError(
			502,
			`could not check the issuer’s peer address with your Hydra Host: ${errorMessage(error)}`,
		);
	}
	if (check.supported && !check.allowed) {
		if (options.rowIsNew) {
			await ports.discard();
			throw createHttpError(
				409,
				`your Hydra Host would not accept the issuer’s peer address (${check.reason ?? 'refused'}). The invite has not been used`,
			);
		}
		throw createHttpError(
			409,
			`your Hydra Host would not accept the issuer’s peer address (${check.reason ?? 'refused'}). The redemption stays recorded; fix the Host’s peer policy and retry the same invite code`,
		);
	}

	const decision = classifyRedemptionAttempt(await ports.post(), { rowIsNew: options.rowIsNew });
	switch (decision.action) {
		case 'accepted': {
			const status = await ports.markAcknowledged();
			if (status === null) {
				throw createHttpError(409, 'this redemption changed while it was being finished; check its status and retry');
			}
			return status;
		}
		case 'discard':
			await ports.discard();
			throw decision.error;
		case 'fail':
			await ports.fail();
			throw decision.error;
		case 'keep':
			throw createHttpError(
				decision.error.status,
				`${decision.error.message}. The redemption is recorded here; retry the same invite code to finish it`,
			);
	}
}

/**
 * Do whatever is left of a redemption. Safe to call again after any failure,
 * from any caller, at any time.
 */
export async function advanceRedemption(
	state: RedemptionState,
	ports: RedemptionPorts,
	options: AdvanceOptions,
): Promise<{ hydraHeadId: string }> {
	// After a fresh acknowledgement, from the record: a concurrent caller that got
	// the same acknowledgement may already have started the node or finished.
	const status = state.acknowledged ? state.status : await acknowledge(state, ports, options);

	// The issuer needed nothing from this Host to acknowledge, so that went ahead.
	// Starting a node or creating a head here would undo the pause.
	if (state.hostPaused) {
		throw createHttpError(
			409,
			'your Hydra Host is paused for maintenance; the redemption continues once it is resumed',
		);
	}

	// Only while the node is not yet marked started. Re-sending these to a node
	// that has been started would override an operator's stop and restart a node
	// that failed, for a step that already happened.
	if (status === 'Redeemed') {
		try {
			if (!samePeers(await ports.currentPeers(), state.issuerPeer)) {
				await ports.setPeers([state.issuerPeer]);
			}
			await ports.start();
			await ports.markStarted();
		} catch (error) {
			throw unfinished(error);
		}
	}

	try {
		return { hydraHeadId: (await ports.createHead()).hydraHeadId };
	} catch (error) {
		// A concurrent finisher wins the link. Its head is this redemption's head.
		const current = await ports.reload().catch(() => null);
		if (current?.status === 'Completed' && current.hydraHeadId !== null) {
			return { hydraHeadId: current.hydraHeadId };
		}
		throw createHttpError.isHttpError(error) ? error : unfinished(error);
	}
}
