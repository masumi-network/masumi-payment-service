/**
 * Recording a head whose net L2 mint balance is not zero.
 *
 * A peer can mint through its own node, and the head cannot reach its final
 * fanout while such a token stays unburned (see `l2-mint-tally`). The node
 * reports an open incident on every verified snapshot and on every replay
 * pass. A peer also decides how often incidents start: minting and burning in
 * turn opens a new one every other snapshot. So each head keeps one row,
 * updated in place to the latest incident, and checks the database at most
 * once per interval. A report that arrives inside the interval is held and
 * checked when the interval ends, so an incident that starts there is written
 * even if the head sends nothing after it.
 *
 * Best effort across processes: there is no unique constraint, so two owners
 * during a lease handover can both write a row. Both rows then follow the
 * latest incident.
 */

import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import type { L2MintIncident } from '@/lib/hydra/hydra/l2-mint-tally';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/** `clientInput` of these rows. The incident's first transaction goes in `txHash`. */
export const UNBURNED_L2_MINT_CLIENT_INPUT = 'L2Mint';

/**
 * How long a head waits after a database check before the next one. Reports
 * arrive per snapshot, so they must not cost a query each. The latest report
 * held during the wait is checked when it ends: that brings back a row an
 * operator cleared while the head is still blocked, and moves the row to a
 * newer incident. A head that sends no report after a check (idle, or Closed)
 * is not checked again until it does.
 */
const RECHECK_INTERVAL_MS = 10 * 60 * 1000;

/** How long a head waits after a failed check, so an outage costs one query per head per interval, not per snapshot. */
const RETRY_INTERVAL_MS = 30 * 1000;

/** Per head: the monotonic time before which reports skip the database. */
const nextCheckByHead = new Map<string, number>();

/** Per head: the latest report that arrived before that time, and the timer that checks it then. */
const heldReportByHead = new Map<
	string,
	{ headStatus: HydraHeadStatus; incident: L2MintIncident; timer: ReturnType<typeof setTimeout> }
>();

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
	const nextCheckAt = nextCheckByHead.get(hydraHeadId) ?? 0;
	if (now < nextCheckAt) {
		const timer =
			heldReportByHead.get(hydraHeadId)?.timer ??
			setTimeout(() => {
				const held = heldReportByHead.get(hydraHeadId);
				heldReportByHead.delete(hydraHeadId);
				if (held) void recordUnburnedL2Mint(hydraHeadId, held.headStatus, held.incident);
			}, nextCheckAt - now).unref();
		heldReportByHead.set(hydraHeadId, { headStatus, incident, timer });
		return;
	}
	// This report is newer than a held one, so this check replaces it.
	clearTimeout(heldReportByHead.get(hydraHeadId)?.timer);
	heldReportByHead.delete(hydraHeadId);
	// Claimed before the first await, so a report that arrives while this one
	// is still writing is held.
	nextCheckByHead.set(hydraHeadId, now + RECHECK_INTERVAL_MS);
	const where = { hydraHeadId, clientInput: UNBURNED_L2_MINT_CLIENT_INPUT };
	try {
		const existing = await prisma.hydraHeadError.findMany({ where, select: { txHash: true } });
		if (existing.length > 0 && existing.every((row) => row.txHash === incident.txHash)) return;
		const data = {
			errorMessage: describeIncident(incident),
			headStatus,
			txHash: incident.txHash,
			errorAt: new Date(),
		};
		if (existing.length > 0) {
			await prisma.hydraHeadError.updateMany({ where, data });
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
