import { z } from '@/utils/zod-openapi';

import { HydraTransactionType } from './types';
import { HydraHeadStatus } from '@/generated/prisma/client';

export const messageSchema = z.looseObject({
	tag: z.string(),
	headStatus: z.string().optional(),
	headId: z.string().optional(),
	hydraHeadId: z.string().nullable().optional(),
	snapshotNumber: z.number().optional(),
	contestationDeadline: z.string().optional(),
});

export const hydraHeadStatusSchema = z.enum(Object.values(HydraHeadStatus));

export const hydraTransactionSchema = z.object({
	type: z.enum(HydraTransactionType),
	cborHex: z.string(),
	description: z.string(),
	txId: z.string(),
});

export const snapshotConfirmedMessageSchema = z.looseObject({
	tag: z.literal('SnapshotConfirmed'),
	snapshot: z.looseObject({
		confirmed: z.array(hydraTransactionSchema),
	}),
});
