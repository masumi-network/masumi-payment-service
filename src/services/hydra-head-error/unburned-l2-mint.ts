/**
 * Recording a head whose net L2 mint balance is not zero.
 *
 * A peer can mint through its own node, and the head cannot reach its final
 * fanout while such a token stays unburned (see `l2-mint-tally`). The node
 * reports an open incident on every verified snapshot and on every replay
 * pass. A peer also decides how often incidents start: minting and burning in
 * turn opens a new one every other snapshot. So each head keeps one row,
 * updated in place to the latest incident, and touches the database at most
 * once per interval.
 *
 * Best effort across processes: there is no unique constraint, so two owners
 * during a lease handover can both write a row. That duplicates a row and
 * loses nothing.
 */

import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import type { L2MintIncident } from '@/lib/hydra/hydra/l2-mint-tally';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/** `clientInput` of these rows. The incident's first transaction goes in `txHash`. */
export const UNBURNED_L2_MINT_CLIENT_INPUT = 'L2Mint';

/**
 * How long a head waits after a database check before the next one. Reports
 * arrive per snapshot, so they must not cost a query each. The first report
 * after the interval checks again: it brings back a row an operator cleared
 * while the head is still blocked, and moves the row to a newer incident.
 * A head that sends no reports (idle, or Closed) is not checked until it does.
 */
const RECHECK_INTERVAL_MS = 10 * 60 * 1000;

/** How long a head waits after a failed check, so an outage costs one query per head per interval, not per snapshot. */
const RETRY_INTERVAL_MS = 30 * 1000;

/** Per head: the monotonic time before which reports skip the database. */
const nextCheckByHead = new Map<string, number>();

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
	const now = performance.now();
	if (now < (nextCheckByHead.get(hydraHeadId) ?? 0)) return;
	// Claimed before the first await, so a report that arrives while this one
	// is still writing skips the database.
	nextCheckByHead.set(hydraHeadId, now + RECHECK_INTERVAL_MS);
	try {
		const existing = await prisma.hydraHeadError.findFirst({
			where: { hydraHeadId, clientInput: UNBURNED_L2_MINT_CLIENT_INPUT },
			select: { id: true, txHash: true },
		});
		if (existing?.txHash === incident.txHash) return;
		const data = {
			errorMessage: describeIncident(incident),
			headStatus,
			txHash: incident.txHash,
			errorAt: new Date(),
		};
		if (existing) {
			await prisma.hydraHeadError.update({ where: { id: existing.id }, data });
		} else {
			await prisma.hydraHeadError.create({
				data: {
					...data,
					hydraHeadId,
					errorType: HydraErrorType.CommandFailed,
					clientInput: UNBURNED_L2_MINT_CLIENT_INPUT,
				},
			});
		}
	} catch (error) {
		nextCheckByHead.set(hydraHeadId, performance.now() + RETRY_INTERVAL_MS);
		logger.error('[HydraHeadError] could not record an unburned L2 mint', {
			hydraHeadId,
			txHash: incident.txHash,
			error: error instanceof Error ? error.message : error,
		});
	}
}
