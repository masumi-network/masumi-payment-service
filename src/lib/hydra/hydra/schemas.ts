import { z } from '@masumi/payment-core/zod';

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

/**
 * Head chain-clock broadcast: release hydra-nodes emit `Tick` on the API
 * websocket for every observed L1 block; Blockfrost-backed master builds emit
 * `SyncedStatusReport` (which additionally carries `drift`/`synced`). Both
 * carry the head's observed L1 time — the clock its ledger validates tx
 * validity intervals against. `chainSlot` is optional because older release
 * `Tick`s carried only `chainTime`.
 */
export const headClockMessageSchema = z.looseObject({
	tag: z.enum(['Tick', 'SyncedStatusReport']),
	chainTime: z.string(),
	chainSlot: z.number().optional(),
});
