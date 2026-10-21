/**
 * Recording a head whose net L2 mint balance is not zero.
 *
 * A peer can mint through its own node, and the head cannot reach its final
 * fanout while such a token stays unburned (see `l2-mint-tally`). The node
 * reports an open incident on every verified snapshot and on every replay
 * pass, so the row is keyed by the transaction that started the incident: one
 * row per incident, however often it is reported.
 *
 * Best effort across processes: there is no unique constraint, so two owners
 * during a lease handover can both write the row. That duplicates a row and
 * loses nothing.
 */

import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import type { L2MintIncident } from '@/lib/hydra/hydra/l2-mint-tally';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/** `clientInput` of these rows. The incident's first transaction goes in `txHash`. */
export const UNBURNED_L2_MINT_CLIENT_INPUT = 'L2Mint';

/**
 * How long a recorded incident goes without a database check. Reports arrive
 * per snapshot, so they must not cost a query each; but an operator can clear
 * the head's errors while the incident is still open, and the row should come
 * back rather than wait for a restart.
 */
const RECORDED_INCIDENT_RECHECK_MS = 10 * 60 * 1000;

/** Per head: the incident last recorded in this process, and when that was confirmed. */
const recordedIncidentByHead = new Map<string, { txHash: string; at: number }>();

function describeIncident(incident: L2MintIncident): string {
	const { count, sample } = incident.netUnits;
	const units = `${sample.join(', ')}${count > sample.length ? `, and ${count - sample.length} more` : ''}`;
	return (
		`Transaction ${incident.txHash} in snapshot ${incident.snapshotNumber} took the net L2 mint balance of the ` +
		`head from zero to nonzero. Units with a nonzero net after that snapshot: ${units}. A token minted inside ` +
		'the head and still unburned blocks its final fanout; partial fanout can still release outputs that do not ' +
		'carry it. The service does not spend UTxOs that carry an L2-minted token.'
	);
}

export async function recordUnburnedL2Mint(
	hydraHeadId: string,
	headStatus: HydraHeadStatus,
	incident: L2MintIncident,
): Promise<void> {
	const now = Date.now();
	const recorded = recordedIncidentByHead.get(hydraHeadId);
	if (recorded?.txHash === incident.txHash && now - recorded.at < RECORDED_INCIDENT_RECHECK_MS) return;
	// Claimed before the first await, so a report that arrives while this one
	// is still writing does not write a second row.
	const claim = { txHash: incident.txHash, at: now };
	recordedIncidentByHead.set(hydraHeadId, claim);
	try {
		const existing = await prisma.hydraHeadError.findFirst({
			where: { hydraHeadId, clientInput: UNBURNED_L2_MINT_CLIENT_INPUT, txHash: incident.txHash },
			select: { id: true },
		});
		if (existing) return;
		await prisma.hydraHeadError.create({
			data: {
				hydraHeadId,
				errorType: HydraErrorType.CommandFailed,
				errorMessage: describeIncident(incident),
				headStatus,
				clientInput: UNBURNED_L2_MINT_CLIENT_INPUT,
				txHash: incident.txHash,
				errorAt: new Date(now),
			},
		});
	} catch (error) {
		// Released so the next report of this incident tries again.
		if (recordedIncidentByHead.get(hydraHeadId) === claim) recordedIncidentByHead.delete(hydraHeadId);
		logger.error('[HydraHeadError] could not record an unburned L2 mint', {
			hydraHeadId,
			txHash: incident.txHash,
			error: error instanceof Error ? error.message : error,
		});
	}
}
