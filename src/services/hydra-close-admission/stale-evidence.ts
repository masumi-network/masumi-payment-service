import { HydraErrorType, HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CLOSE_NONEXECUTION_CLIENT_INPUT_PREFIX } from './nonexecution-evidence';

/** Keep periodic cleanup bounded; later scheduler passes handle the remainder. */
const STALE_EVIDENCE_CLEANUP_BATCH_SIZE = 100;

/**
 * Delete only fallback proofs that no current Open Close admission can use.
 *
 * The active-admission check belongs in the DELETE statement. A separate head
 * read could race with a new proof write and remove the only release evidence.
 * A disabled head can be re-enabled, so its matching proof remains active.
 */
export async function deleteStaleCloseNonexecutionEvidence(headId?: string): Promise<number> {
	const headScope = headId === undefined ? Prisma.empty : Prisma.sql`AND error."hydraHeadId" = ${headId}`;
	const batchLimit = headId === undefined ? Prisma.sql`LIMIT ${STALE_EVIDENCE_CLEANUP_BATCH_SIZE}` : Prisma.empty;
	return prisma.$executeRaw(Prisma.sql`
		WITH stale AS (
			SELECT error."id"
			FROM "HydraHeadError" AS error
			WHERE error."clientInput" LIKE ${`${CLOSE_NONEXECUTION_CLIENT_INPUT_PREFIX}%`}
				AND error."errorType" = CAST(${HydraErrorType.CommandFailed} AS "HydraErrorType")
			${headScope}
				AND NOT EXISTS (
					SELECT 1
					FROM "HydraHead" AS head
					WHERE head."id" = error."hydraHeadId"
						AND head."status" = CAST(${HydraHeadStatus.Open} AS "HydraHeadStatus")
						AND head."isClosing" = TRUE
						AND head."closeAdmissionId" IS NOT NULL
						AND error."clientInput" = ${CLOSE_NONEXECUTION_CLIENT_INPUT_PREFIX} || head."closeAdmissionId"
				)
			ORDER BY error."errorAt", error."id"
			${batchLimit}
		)
		DELETE FROM "HydraHeadError" AS error
		USING stale
		WHERE error."id" = stale."id"
	`);
}
