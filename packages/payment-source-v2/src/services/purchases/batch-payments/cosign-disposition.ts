import type { CosignDecision, CosignMemberVerdict } from '../../../smart-wallet/cosign-client';

/**
 * What happens to one purchase the quorum did not co-sign.
 *
 * `retry` keeps the purchase queued (`FundsLockingRequested`, no error type, so
 * the next tick selects it again). `manual` parks it in `WaitingForManualAction`.
 * Nothing was submitted in either case: without the quorum's witnesses the
 * transaction cannot land on chain.
 */
export type CosignDisposition = { kind: 'retry'; note: string } | { kind: 'manual'; policy: boolean; note: string };

export type CosignClassification =
	| { kind: 'approved' }
	/** Rebuild with exactly `keep`, under the same batch id; `refused` covers everyone else. */
	| { kind: 'rebuild'; keep: string[]; refused: Map<string, CosignDisposition> }
	/** Every purchase in the batch has a disposition. */
	| { kind: 'refused'; refused: Map<string, CosignDisposition> };

export type CosignOutcome = CosignDecision | { transportError: string };

/** Batch denials that clear on their own: Exchain lagging the chain, clocks, a concurrent hold. */
const TRANSIENT_BATCH_CODES = new Set(['utxo_unknown', 'clock_skew', 'reservation_conflict']);
/** Batch denials that are a policy decision about this wallet or payee. */
const POLICY_BATCH_CODES = new Set(['asset_not_listed', 'payee_unpinned']);
/** A member denial that is a rate window, not a spent budget. */
const TRANSIENT_MEMBER_CODES = new Set(['velocity_burst']);

function denialNote(code: string, reason: string | undefined, journalRef: string): string {
	return `Exchain ${code}: ${reason ?? 'no reason given'} (journal ${journalRef})`;
}

function everyone(purchaseIds: string[], disposition: CosignDisposition): Map<string, CosignDisposition> {
	return new Map(purchaseIds.map((purchaseId) => [purchaseId, disposition]));
}

function memberDisposition(member: CosignMemberVerdict | undefined, journalRef: string): CosignDisposition {
	if (member?.verdict !== 'denied' || member.denied == null) {
		// Allowed but not kept, or never evaluated: nothing is wrong with it.
		return { kind: 'retry', note: 'Exchain did not evaluate this purchase in its batch; retrying' };
	}
	const note = denialNote(member.denied, member.reasonEnglish, journalRef);
	if (TRANSIENT_MEMBER_CODES.has(member.denied)) return { kind: 'retry', note: `${note}; retrying` };
	return { kind: 'manual', policy: true, note };
}

/**
 * Map one co-sign answer to a per-purchase outcome.
 *
 * `canRebuild` is false once this tick has already rebuilt: a second denial of
 * the admitted set sends it back to the queue instead of looping.
 */
export function classifyCosignResult(
	outcome: CosignOutcome,
	purchaseIds: string[],
	canRebuild: boolean,
	nowMs: number = Date.now(),
): CosignClassification {
	if ('transportError' in outcome) {
		return {
			kind: 'refused',
			refused: everyone(purchaseIds, {
				kind: 'retry',
				note: `Exchain co-sign unreachable: ${outcome.transportError}; retrying`,
			}),
		};
	}
	if (outcome.httpStatus === 200) return { kind: 'approved' };
	if (outcome.httpStatus === 503) {
		const { reachable, threshold } = outcome.unavailable;
		return {
			kind: 'refused',
			refused: everyone(purchaseIds, {
				kind: 'retry',
				note: `Exchain quorum unavailable (${reachable}/${threshold} reachable); retrying`,
			}),
		};
	}

	const denial = outcome.denied;
	const note = denialNote(denial.denied, denial.reasonEnglish, denial.journalRef);
	if (denial.denied !== 'member_denied') {
		if (TRANSIENT_BATCH_CODES.has(denial.denied)) {
			return { kind: 'refused', refused: everyone(purchaseIds, { kind: 'retry', note: `${note}; retrying` }) };
		}
		// An unknown code or a body mismatch is not a policy verdict: our build or the reply is wrong.
		const policy = POLICY_BATCH_CODES.has(denial.denied);
		return { kind: 'refused', refused: everyone(purchaseIds, { kind: 'manual', policy, note }) };
	}

	const keep = new Set(denial.rebuild?.keep ?? []);
	const holdIsLive = denial.rebuild != null && Date.parse(denial.rebuild.heldUntil) > nowMs;
	const rebuild = canRebuild && holdIsLive && keep.size > 0;
	const refused = new Map<string, CosignDisposition>();
	for (const purchaseId of purchaseIds) {
		if (keep.has(purchaseId)) {
			if (!rebuild) refused.set(purchaseId, { kind: 'retry', note: 'Exchain admitted this purchase; retrying' });
			continue;
		}
		const member = denial.members.find((candidate) => candidate.purchaseId === purchaseId);
		refused.set(purchaseId, memberDisposition(member, denial.journalRef));
	}
	if (rebuild) return { kind: 'rebuild', keep: purchaseIds.filter((id) => keep.has(id)), refused };
	return { kind: 'refused', refused };
}
