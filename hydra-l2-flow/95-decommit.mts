/**
 * Decommit — withdraw lovelace from the OPEN head back to L1 through Masumi's
 * own withdrawal service (executeHydraDecommit), without closing the head.
 *
 * Exists because the recorded-history fixture has to carry a real decommit
 * (utxoToDecommit + the DecommitRequested transaction): that partition carries
 * its own L1 fee, and mis-accounting it is exactly the bug the fixture guards.
 * A decommit requested while a commit is still pending is held by the node and
 * declared in the snapshot that absorbs that commit — which is what puts the
 * commit and the decommit in consecutive snapshots.
 *
 * Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/95-decommit.mts <lovelace>
 */
import { prisma } from '@masumi/payment-core/db';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { executeHydraDecommit } from '@/services/hydra-decommit/execute';

// The service marks its "accepted, settles by head frame" outcome with this
// global symbol (Symbol.for) rather than exporting it; naming it here keeps the
// service surface as it is.
const ACCEPTED_BUT_UNCONFIRMED = Symbol.for('masumi.hydra.decommit.acceptedButUnconfirmed');

const log = (m: string) => console.log(`[decommit] ${new Date().toISOString().slice(11, 19)} ${m}`);

async function main() {
	const lovelace = BigInt(process.argv[2] ?? '3000000');
	const head = await prisma.hydraHead.findFirstOrThrow({
		where: { isEnabled: true },
		orderBy: { createdAt: 'desc' },
		include: { LocalParticipant: true },
	});
	const cm = getHydraConnectionManager();
	await cm.connect({
		id: head.id,
		LocalParticipant: {
			walletId: head.LocalParticipant!.walletId,
			nodeHttpUrl: head.LocalParticipant!.nodeHttpUrl,
			nodeUrl: head.LocalParticipant!.nodeUrl,
		},
	});
	await new Promise((r) => setTimeout(r, 800));

	log(`withdrawing ${lovelace} lovelace from head ${head.headIdentifier?.slice(0, 12)}… via executeHydraDecommit()`);
	try {
		const result = await executeHydraDecommit({ headId: head.id, lovelace });
		log(
			`decommit confirmed by the node: decommitTx ${result.decommitTxId} (split ${result.splitTxId ?? 'none'}) → ${result.destinationAddress.slice(0, 24)}… ${result.withdrawnLovelace} lovelace`,
		);
	} catch (error) {
		// hydra-node holds POST /decommit open until the L1 decrement is
		// FINALIZED (minutes on preprod), while the service's HTTP client gives up
		// after 30 s. The service then deliberately leaves the row Pending for the
		// head's own DecommitApproved/DecommitFinalized frames to settle — an
		// accepted withdrawal, not a failed one. Observed live on 2.4.1: approved
		// 2 s after the request, finalized 32 s after, client timeout 30 s.
		if (error !== null && typeof error === 'object' && (error as Record<symbol, unknown>)[ACCEPTED_BUT_UNCONFIRMED]) {
			log(`accepted, not yet confirmed: ${(error as Error).message}`);
			log(
				'the node holds the request until the L1 decrement finalizes; the HydraDecommit row settles from the head frames',
			);
		} else {
			throw error;
		}
	}
	const row = await prisma.hydraDecommit.findFirst({ where: { hydraHeadId: head.id }, orderBy: { createdAt: 'desc' } });
	log(`HydraDecommit ${row?.id} status=${row?.status} decommitTx=${row?.decommitTxId?.slice(0, 12)}…`);
	await prisma.$disconnect();
	process.exit(0);
}

main().catch(async (e) => {
	console.error('[decommit] FAILED:', e instanceof Error ? e.message : e);
	await prisma.$disconnect();
	process.exit(1);
});
