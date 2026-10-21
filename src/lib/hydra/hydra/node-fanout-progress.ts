/**
 * What a head in FanningOut still has to fan out.
 *
 * hydra-node 2.4.1 reports each partial fanout step as `HeadPartiallyFannedOut`
 * with the UTxO set that remains. Nothing else reports it: `GET /snapshot/utxo`
 * keeps returning the confirmed snapshot during FanningOut (`getSnapshotUtxo`
 * in `Hydra/API/ServerOutput.hs` at 2.4.1). The next selection must be a
 * sub-multiset of the remaining set, so it is built from the newest frame.
 *
 * The set is the local node's own report and is only used to build a selection
 * the node validates again. A step that L1 rolls back emits no frame
 * (`HeadFanoutReverted` has no server output), so the set can be ahead of the
 * node for a while. The node then refuses the selection with `CommandFailed`.
 */

import { z } from '@masumi/payment-core/zod';

import { canonicalHydraHeadIdSchema, hydraSnapshotUtxoSchema } from './schemas';

export const headPartiallyFannedOutMessageSchema = z.looseObject({
	tag: z.literal('HeadPartiallyFannedOut'),
	headId: canonicalHydraHeadIdSchema,
	seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	remainingUTxO: hydraSnapshotUtxoSchema,
	fanoutMode: z.string().max(64).optional(),
});

export type HydraFanoutRemainingUtxo = z.infer<typeof hydraSnapshotUtxoSchema>;

export type HydraFanoutProgress = {
	remainingUTxO: HydraFanoutRemainingUtxo;
	/** `AwaitingFanoutSelection` when the node waits for the next selection. */
	fanoutMode: string | undefined;
};

export class FanoutProgressState {
	private latest: (HydraFanoutProgress & { seq: number | undefined }) | undefined;

	/**
	 * Keep the newest step. History replay re-reports older steps on every
	 * reconnect, so a frame with a lower sequence number than the one held is
	 * ignored. A frame without one replaces the held step.
	 */
	record(message: unknown, assertExpectedHeadId: (parsed: { headId: string }) => void): void {
		const parsed = headPartiallyFannedOutMessageSchema.parse(message);
		assertExpectedHeadId(parsed);
		const heldSeq = this.latest?.seq;
		if (heldSeq != null && parsed.seq != null && parsed.seq < heldSeq) return;
		this.latest = { remainingUTxO: parsed.remainingUTxO, fanoutMode: parsed.fanoutMode, seq: parsed.seq };
	}

	clear(): void {
		this.latest = undefined;
	}

	/** The remaining set from the newest partial fanout step, while FanningOut. */
	current(): HydraFanoutProgress | undefined {
		if (!this.latest) return undefined;
		return { remainingUTxO: this.latest.remainingUTxO, fanoutMode: this.latest.fanoutMode };
	}
}
