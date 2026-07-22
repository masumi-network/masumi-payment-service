import { Prisma } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';

export const quarantineStatusSchema = z.enum(['Unresolved', 'Pending', 'NeedsOperator', 'Resolved', 'All']);
export const DEFAULT_QUARANTINE_STATUS = 'Unresolved' as const;

export type QuarantineStatus = z.infer<typeof quarantineStatusSchema>;

export function getQuarantineStatusFilter(
	status: QuarantineStatus = DEFAULT_QUARANTINE_STATUS,
): Prisma.TxSyncQuarantineWhereInput {
	switch (status) {
		case 'Unresolved':
			return { resolvedAt: null };
		case 'Pending':
			return { resolvedAt: null, needsOperator: false };
		case 'NeedsOperator':
			return { resolvedAt: null, needsOperator: true };
		case 'Resolved':
			return { resolvedAt: { not: null } };
		case 'All':
			return {};
	}
}
