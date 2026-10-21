/**
 * Recording a head whose net L2 mint balance is not zero.
 *
 * A peer can mint through its own node, and the head cannot reach its final
 * fanout while such a token stays unburned (see `l2-mint-tally`). The node
 * reports an open incident on every verified snapshot and on every replay
 * pass. A peer also decides how often incidents start: minting and burning in
 * turn opens a new one every other snapshot. So each head keeps one row,
 * updated in place to the latest incident, and runs one database check at a
 * time, at most once per interval. A report that arrives in between is kept
 * and checked when the interval ends, so an incident that starts there is
 * written even if the head sends nothing after it.
 *
 * Best effort across processes: there is no unique constraint, so two owners
 * during a lease handover can both write a row. Each check moves every row of
 * the head to its incident. A process drops its kept report when it stops the
 * head, so it does not write after the handover.
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
 * kept during the wait is checked when it ends: that brings back a row an
 * operator cleared, and moves the row to a newer incident. The node does not
 * report an incident closing, so a kept report is written even if its
 * incident closed during the wait. A head that sends no report after a check
 * (idle, or Closed) is not checked again until it does.
 */
const RECHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How long a head waits after a failed check. An outage costs one query per
 * head per interval, not per snapshot. The failed report itself is not kept;
 * the next report brings the incident back.
 */
const RETRY_INTERVAL_MS = 30 * 1000;

type Report = { headStatus: HydraHeadStatus; incident: L2MintIncident };

interface HeadReports {
	/** Monotonic time before which no check starts. */
	nextCheckAt: number;
	/** The latest report not yet checked. */
	pending?: Report;
	/** Starts the check of `pending` at `nextCheckAt`. */
	timer?: ReturnType<typeof setTimeout>;
	/** One check at a time, so an older check that stalls cannot finish after a newer one. */
	isChecking: boolean;
}

const reportsByHead = new Map<string, HeadReports>();

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

/** Moves every row of the head to the incident, or creates the row. One query when every row already names it. */
async function writeIncident(hydraHeadId: string, { headStatus, incident }: Report): Promise<void> {
	const where = { hydraHeadId, clientInput: UNBURNED_L2_MINT_CLIENT_INPUT };
	const existing = await prisma.hydraHeadError.findMany({ where, select: { txHash: true } });
	if (existing.length > 0 && existing.every((row) => row.txHash === incident.txHash)) return;
	const data = { errorMessage: describeIncident(incident), headStatus, txHash: incident.txHash, errorAt: new Date() };
	// An operator can clear the rows between the read and this write.
	if (existing.length > 0 && (await prisma.hydraHeadError.updateMany({ where, data })).count > 0) return;
	await prisma.hydraHeadError.create({
		data: { ...data, hydraHeadId, errorType: HydraErrorType.CommandFailed, clientInput: UNBURNED_L2_MINT_CLIENT_INPUT },
	});
}

function armCheck(hydraHeadId: string, head: HeadReports): void {
	head.timer = setTimeout(
		() => {
			head.timer = undefined;
			void checkPending(hydraHeadId, head);
		},
		Math.max(0, head.nextCheckAt - performance.now()),
	).unref();
}

async function checkPending(hydraHeadId: string, head: HeadReports): Promise<void> {
	const report = head.pending;
	if (!report) return;
	head.pending = undefined;
	head.isChecking = true;
	let wait = RECHECK_INTERVAL_MS;
	try {
		await writeIncident(hydraHeadId, report);
	} catch (error) {
		wait = RETRY_INTERVAL_MS;
		logger.error('[HydraHeadError] could not record an unburned L2 mint', {
			hydraHeadId,
			txHash: report.incident.txHash,
			error: error instanceof Error ? error.message : error,
		});
	}
	head.isChecking = false;
	head.nextCheckAt = performance.now() + wait;
	// A report that arrived during this check waits for the next one, unless
	// the head was dropped meanwhile.
	if (head.pending && reportsByHead.get(hydraHeadId) === head) armCheck(hydraHeadId, head);
}

export async function recordUnburnedL2Mint(
	hydraHeadId: string,
	headStatus: HydraHeadStatus,
	incident: L2MintIncident,
): Promise<void> {
	let head = reportsByHead.get(hydraHeadId);
	if (!head) {
		head = { nextCheckAt: 0, isChecking: false };
		reportsByHead.set(hydraHeadId, head);
	}
	head.pending = { headStatus, incident };
	if (head.isChecking || head.timer) return;
	if (performance.now() < head.nextCheckAt) {
		armCheck(hydraHeadId, head);
		return;
	}
	await checkPending(hydraHeadId, head);
}

/** Forgets the head's kept report, so this process writes nothing for it after it stops the head. */
export function dropUnburnedL2MintReports(hydraHeadId: string): void {
	clearTimeout(reportsByHead.get(hydraHeadId)?.timer);
	reportsByHead.delete(hydraHeadId);
}
