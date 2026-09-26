/**
 * Milestone 4 identity retention evidence — READ ONLY.
 *
 * For every L2 transaction the service produced, follow the trail the product
 * already keeps: Transaction (layer=L2, hydraHeadId) -> PurchaseRequest /
 * PaymentRequest (agentIdentifier) -> RegistryRequest (the agent NFT) ->
 * AgentVerification (the KERI-ACDC claims attached at registration).
 * Nothing here writes, and nothing here touches the verification code.
 *
 * Run:      DATABASE_URL=<bench-db> pnpm exec tsx hydra-l2-flow/20-identity-audit-log.mts
 * Selftest: pnpm exec tsx hydra-l2-flow/20-identity-audit-log.mts --selftest
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TransactionLayer } from '@/generated/prisma/client';
import { EVIDENCE_ROOT, log } from './m4-lib.mts';

const OUT_DIR = join(EVIDENCE_ROOT, 'identity');

type Row = {
	side: 'purchase' | 'payment';
	requestId: string;
	blockchainIdentifier: string;
	onChainState: string | null;
	txHash: string | null;
	hydraHeadId: string | null;
	agentIdentifier: string | null;
	agentName: string | null;
	verificationMethod: string | null;
	issuerAid: string | null;
	holderAid: string | null;
	credentialSaid: string | null;
};

/**
 * Pure: the L2 transactions for one request, deduped by id. History is
 * filtered to L2 (L1 entries dropped); the current transaction is included
 * as-is (the caller's query already guarantees it is L2) and, if it also
 * appears in history, counted once. Null current is tolerated. Exported for
 * the selftest.
 */
export function dedupedL2Transactions<T extends { id: string; layer: TransactionLayer }>(
	history: readonly T[],
	current: T | null,
): T[] {
	const combined = [...history.filter((t) => t.layer === TransactionLayer.L2), ...(current ? [current] : [])];
	return combined.filter((t, i, all) => all.findIndex((o) => o.id === t.id) === i);
}

/**
 * Pure: Task 8's acceptance bar — at least one row, and every row carries
 * both the agent identifier and the KERI verification method. Exported for
 * the selftest.
 */
export function isAuditComplete(rows: readonly Pick<Row, 'agentIdentifier' | 'verificationMethod'>[]): boolean {
	return rows.length > 0 && rows.every((x) => Boolean(x.agentIdentifier) && Boolean(x.verificationMethod));
}

function selftest(): void {
	type Tx = { id: string; layer: TransactionLayer };
	const l2 = (id: string): Tx => ({ id, layer: TransactionLayer.L2 });
	const l1 = (id: string): Tx => ({ id, layer: TransactionLayer.L1 });

	// Current tx also present in history -> one row, not two.
	assert.deepEqual(dedupedL2Transactions([l2('a')], l2('a')), [l2('a')]);
	// L1 history entries excluded.
	assert.deepEqual(dedupedL2Transactions([l1('a'), l2('b')], null), [l2('b')]);
	// Null current transaction tolerated.
	assert.deepEqual(dedupedL2Transactions([l2('a'), l2('b')], null), [l2('a'), l2('b')]);
	// Current transaction absent from history is still appended.
	assert.deepEqual(dedupedL2Transactions([l2('a')], l2('c')), [l2('a'), l2('c')]);

	const row = (agentIdentifier: string | null, verificationMethod: string | null) => ({ agentIdentifier, verificationMethod });

	// False on empty rows.
	assert.equal(isAuditComplete([]), false);
	// False when one row lacks verificationMethod.
	assert.equal(isAuditComplete([row('agent1', 'KERI-ACDC'), row('agent2', null)]), false);
	// False when one row lacks agentIdentifier.
	assert.equal(isAuditComplete([row(null, 'KERI-ACDC')]), false);
	// True on a complete set.
	assert.equal(isAuditComplete([row('agent1', 'KERI-ACDC'), row('agent2', 'KERI-ACDC')]), true);

	console.log('selftest ok');
}

async function main(): Promise<void> {
	if (process.argv.includes('--selftest')) return selftest();

	// Imported only on the live path: importing @masumi/payment-core/db at
	// module scope would build a pg Pool from DATABASE_URL immediately, which
	// --selftest must not require.
	const { prisma } = await import('@masumi/payment-core/db');

	const purchases = await prisma.purchaseRequest.findMany({
		where: { CurrentTransaction: { layer: TransactionLayer.L2 } },
		include: { CurrentTransaction: true, TransactionHistory: true },
		orderBy: { createdAt: 'asc' },
	});
	const payments = await prisma.paymentRequest.findMany({
		where: { CurrentTransaction: { layer: TransactionLayer.L2 } },
		include: { CurrentTransaction: true, TransactionHistory: true },
		orderBy: { createdAt: 'asc' },
	});
	log('identity', `${purchases.length} L2 purchase(s), ${payments.length} L2 payment(s)`);

	const rows: Row[] = [];
	const requests = [
		...purchases.map((r) => ({ side: 'purchase' as const, r })),
		...payments.map((r) => ({ side: 'payment' as const, r })),
	];
	for (const { side, r } of requests) {
		const registry = r.agentIdentifier
			? await prisma.registryRequest.findFirst({ where: { agentIdentifier: r.agentIdentifier }, include: { Verifications: true } })
			: null;
		const claim = registry?.Verifications[0] ?? null;
		const txs = dedupedL2Transactions(r.TransactionHistory, r.CurrentTransaction);
		for (const t of txs) {
			rows.push({
				side, requestId: r.id, blockchainIdentifier: r.blockchainIdentifier, onChainState: r.onChainState,
				txHash: t.txHash, hydraHeadId: t.hydraHeadId, agentIdentifier: r.agentIdentifier, agentName: registry?.name ?? null,
				verificationMethod: claim?.method ?? null, issuerAid: claim?.issuerAid ?? null, holderAid: claim?.holderAid ?? null, credentialSaid: claim?.credentialSaid ?? null,
			});
		}
	}

	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(join(OUT_DIR, 'audit-log.json'), JSON.stringify({ generated: new Date().toISOString(), rows }, null, 2));
	const lines = [
		'# Milestone 4: L2 audit log with agent identity (preprod)', '',
		`Generated ${new Date().toISOString()}. Every row is an in-head (L2) transaction the payment service built, joined to the agent it paid through fields the product already stores. No identity code was changed to produce this.`, '',
		'| Side | L2 tx | Head | Request state | Agent identifier (registry NFT) | Agent | KERI method | Issuer AID | Holder AID | Credential SAID |',
		'|---|---|---|---|---|---|---|---|---|---|',
		...rows.map((x) => `| ${x.side} | \`${(x.txHash ?? '').slice(0, 16)}…\` | \`${(x.hydraHeadId ?? '').slice(0, 8)}…\` | ${x.onChainState ?? ''} | \`${(x.agentIdentifier ?? '').slice(0, 20)}…\` | ${x.agentName ?? ''} | ${x.verificationMethod ?? '—'} | \`${x.issuerAid ?? '—'}\` | \`${x.holderAid ?? '—'}\` | \`${x.credentialSaid ?? '—'}\` |`),
		'', 'Reproduce any row: `GET /api/v1/purchase` or `GET /api/v1/payment` returns `agentIdentifier`, `CurrentTransaction.layer` and `CurrentTransaction.hydraHeadId`; `GET /api/v1/registry?network=Preprod` returns the same agent with its `verifications`.',
	];
	writeFileSync(join(OUT_DIR, 'AUDIT-LOG.md'), `${lines.join('\n')}\n`);
	log('identity', `${rows.length} row(s) written to ${OUT_DIR}`);
	await prisma.$disconnect();
	process.exit(isAuditComplete(rows) ? 0 : 1);
}

main().catch((error) => {
	console.error(`[identity] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
