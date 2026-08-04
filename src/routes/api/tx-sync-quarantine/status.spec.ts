import { DEFAULT_QUARANTINE_STATUS, getQuarantineStatusFilter, quarantineStatusSchema } from './status';

describe('tx-sync quarantine status', () => {
	it('accepts Unresolved and maps it to every unresolved entry', () => {
		expect(DEFAULT_QUARANTINE_STATUS).toBe('Unresolved');
		expect(quarantineStatusSchema.parse('Unresolved')).toBe('Unresolved');
		expect(getQuarantineStatusFilter()).toEqual({ resolvedAt: null });
	});

	it('keeps Pending distinct from operator-held entries', () => {
		expect(getQuarantineStatusFilter('Pending')).toEqual({ resolvedAt: null, needsOperator: false });
		expect(getQuarantineStatusFilter('NeedsOperator')).toEqual({ resolvedAt: null, needsOperator: true });
	});
});
