/**
 * Re-point the seeded preprod Hydra head at freshly generated node keys while it
 * is still pristine and Idle. This helper deliberately refuses every started or
 * finalized protocol session: rewriting live keys can orphan funds, while
 * recycling a Final row would mix a new head with the old session's transaction
 * history. Create a new head after finalization instead.
 *
 * This is offline maintenance: first disable the head through the admin API,
 * then stop every payment-service replica and both Hydra nodes for this head.
 * The explicit flag records that operator assertion; database locks alone
 * cannot fence a lifecycle command already sent to an external Hydra node.
 *
 * Run: pnpm exec tsx hydra-l2-flow/reconcile-hydra-head-keys.mts <exact-head-id> --maintenance-window-confirmed
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@masumi/payment-core/db';
import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { encrypt } from '@/utils/security/encryption';
import { Network, Prisma } from '@/generated/prisma/client';
import { normalizeHydraSigningKeyCborHex, normalizeHydraVerificationKeyCborHex } from '@/lib/hydra';
import { isHydraHeadKeyReconciliationEligible } from '@/lib/hydra/hydra/head-key-reconciliation';

const PREPROD = join(process.cwd(), 'hydra-l2-flow', 'preprod');
const MAINTENANCE_CONFIRMATION = '--maintenance-window-confirmed';
const cbor = (name: string): string => {
	const envelope: unknown = JSON.parse(readFileSync(join(PREPROD, name), 'utf8'));
	if (!isPlainObject(envelope)) throw new Error(`${name} is not a Hydra key text envelope`);
	const cborHex = getOwnValue(envelope, 'cborHex');
	if (typeof cborHex !== 'string') throw new Error(`${name} omitted cborHex`);
	return cborHex;
};

async function main() {
	const arguments_ = process.argv.slice(2);
	const headId = arguments_.find((argument) => !argument.startsWith('--'))?.trim();
	if (!headId) throw new Error('pass the exact HydraHead id to reconcile');
	if (!arguments_.includes(MAINTENANCE_CONFIRMATION)) {
		throw new Error(
			`offline maintenance required: disable the head, stop every payment-service replica and both Hydra nodes, then pass ${MAINTENANCE_CONFIRMATION}`,
		);
	}
	const localSk = normalizeHydraSigningKeyCborHex(cbor('purchasing-hydra.sk'));
	const remoteVk = normalizeHydraVerificationKeyCborHex(cbor('selling-hydra.vk'));
	const encryptedLocalSk = encrypt(localSk);

	const result = await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					// Match lifecycle writers' relation-first order, then lock every
					// sibling head before the target's participants and key rows.
					const lockedRelations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
						SELECT relation."id"
						FROM "HydraRelation" relation
						INNER JOIN "HydraHead" head ON head."hydraRelationId" = relation."id"
						WHERE head."id" = ${headId}
						FOR UPDATE OF relation
					`);
					if (lockedRelations.length !== 1) throw new Error(`Hydra head ${headId} was not found`);
					const hydraRelationId = lockedRelations[0]!.id;

					const lockedHeads = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
						SELECT "id"
						FROM "HydraHead"
						WHERE "hydraRelationId" = ${hydraRelationId}
						ORDER BY "id"
						FOR UPDATE
					`);
					if (!lockedHeads.some(({ id }) => id === headId)) {
						throw new Error(`Hydra head ${headId} changed relation during maintenance`);
					}
					await tx.$queryRaw(Prisma.sql`
						SELECT "id"
						FROM "HydraLocalParticipant"
						WHERE "hydraHeadId" = ${headId}
						ORDER BY "id"
						FOR UPDATE
					`);
					await tx.$queryRaw(Prisma.sql`
						SELECT "id"
						FROM "HydraRemoteParticipant"
						WHERE "hydraHeadId" = ${headId}
						ORDER BY "id"
						FOR UPDATE
					`);
					await tx.$queryRaw(Prisma.sql`
						SELECT secret."id"
						FROM "HydraSecretKey" secret
						INNER JOIN "HydraLocalParticipant" participant
							ON participant."hydraSecretKeyId" = secret."id"
						WHERE participant."hydraHeadId" = ${headId}
						ORDER BY secret."id"
						FOR UPDATE OF secret
					`);
					await tx.$queryRaw(Prisma.sql`
						SELECT verification."id"
						FROM "HydraVerificationKey" verification
						INNER JOIN "HydraRemoteParticipant" participant
							ON participant."hydraVerificationKeyId" = verification."id"
						WHERE participant."hydraHeadId" = ${headId}
						ORDER BY verification."id"
						FOR UPDATE OF verification
					`);

					const head = await tx.hydraHead.findUnique({
						where: { id: headId },
						include: {
							HydraRelation: { select: { network: true } },
							LocalParticipant: { include: { HydraSecretKey: true } },
							RemoteParticipants: { include: { HydraVerificationKey: true } },
							_count: { select: { Transactions: true, Errors: true } },
						},
					});
					if (!head || head.hydraRelationId !== hydraRelationId) {
						throw new Error(`Hydra head ${headId} changed during maintenance`);
					}
					if (head.HydraRelation.network !== Network.Preprod) {
						throw new Error('key reconciliation is restricted to the preprod maintenance head');
					}
					if (head.isEnabled) {
						throw new Error(`refusing to replace keys for enabled head ${head.id}; disable it before shutdown`);
					}
					if (
						!isHydraHeadKeyReconciliationEligible({
							...head,
							transactionCount: head._count.Transactions,
							errorCount: head._count.Errors,
							localParticipant: head.LocalParticipant,
							remoteParticipants: head.RemoteParticipants,
						})
					) {
						throw new Error(
							`refusing to replace keys for head ${head.id}: it has protocol evidence or is not a pristine Idle session; create a new head instead`,
						);
					}

					const local = head.LocalParticipant!;
					const remote = head.RemoteParticipants[0]!;
					const localUpdated = await tx.hydraSecretKey.updateMany({
						where: {
							id: local.HydraSecretKey.id,
							hydraSK: local.HydraSecretKey.hydraSK,
						},
						data: { hydraSK: encryptedLocalSk },
					});
					// Verification keys are public evidence and are consumed as
					// canonical CBOR by snapshot-signature verification.
					const remoteUpdated = await tx.hydraVerificationKey.updateMany({
						where: {
							id: remote.HydraVerificationKey.id,
							hydraVK: remote.HydraVerificationKey.hydraVK,
						},
						data: { hydraVK: remoteVk },
					});
					if (localUpdated.count !== 1 || remoteUpdated.count !== 1) {
						throw new Error('Hydra participant key ownership changed during maintenance');
					}

					return {
						headId: head.id,
						localParticipantId: local.id,
						remoteParticipantId: remote.id,
					};
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 10_000,
					timeout: 10_000,
				},
			),
		{ label: 'hydra-head-key-reconciliation' },
	);

	console.log(
		JSON.stringify(
			{
				...result,
				headState: 'disabled pristine Idle (unchanged)',
				keysRepointed: true,
			},
			null,
			2,
		),
	);
	await prisma.$disconnect();
	process.exit(0);
}

main().catch(async (e) => {
	console.error(e);
	await prisma.$disconnect();
	process.exit(1);
});
