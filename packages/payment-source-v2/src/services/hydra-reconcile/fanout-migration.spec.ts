import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

describe('Hydra fanout finality migrations', () => {
	it('requires a canonical independently verified fanout hash before reconciliation completes', () => {
		const migrationSql = readFileSync(
			join(process.cwd(), 'prisma/migrations/20260723030000_guard_hydra_finalization/migration.sql'),
			'utf8',
		);

		expect(migrationSql).toContain('"reconciliationCompletedAt" IS NULL');
		expect(migrationSql).toContain('"fanoutTxHash" ~ \'^[0-9a-f]{64}$\'');
		expect(migrationSql).toContain('HydraHead_fanout_tx_hash_canonical_check');
	});

	it('makes every request handoff marker all-or-none with a canonical transaction hash', () => {
		const migrationSql = readFileSync(
			join(process.cwd(), 'prisma/migrations/20260723040000_add_hydra_fanout_handoff/migration.sql'),
			'utf8',
		);

		expect(migrationSql.match(/hydra_fanout_handoff_complete_check/g)).toHaveLength(2);
		expect(migrationSql.match(/"hydraFanoutHandoffTxHash" ~ '\^\[0-9a-f\]\{64\}\$'/g)).toHaveLength(2);
		expect(migrationSql.match(/"hydraFanoutHandoffOutputIndex" >= 0/g)).toHaveLength(2);
		expect(migrationSql).toContain(
			'CREATE INDEX "PaymentRequest_hydraFanoutHandoffHeadId_idx"\nON "PaymentRequest"("hydraFanoutHandoffHeadId")',
		);
		expect(migrationSql).toContain(
			'CREATE INDEX "PurchaseRequest_hydraFanoutHandoffHeadId_idx"\nON "PurchaseRequest"("hydraFanoutHandoffHeadId")',
		);
		expect(migrationSql).not.toContain('hydraFanoutHandoffTxHash_idx');
	});
});
