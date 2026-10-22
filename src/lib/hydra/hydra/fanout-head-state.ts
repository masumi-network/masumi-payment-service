/**
 * What a closed head can still fan out, read from the node's own head state.
 *
 * `GET /head` returns the hydra-node 2.4.1 `HeadState`, and the node checks a
 * `PartialFanout` selection against that same state:
 * - `Closed`: the confirmed snapshot's `utxo`, plus `utxoToCommit` only when
 *   the snapshot version differs from the on-chain version, plus
 *   `utxoToDecommit` only when they match (`fanoutUTxOFromSnapshot` in
 *   `Hydra/HeadLogic.hs`).
 * - `FanoutProgress`: `remainingOutputs`, and `mode` says whether the node is
 *   still fanning out on its own.
 *
 * `GET /snapshot/utxo` is not this set. It always adds `utxoToCommit`, never
 * the decommit outputs, and keeps the confirmed snapshot during
 * FanoutProgress (`getSnapshotUtxo` in `Hydra/API/ServerOutput.hs`).
 */

import { z } from '@masumi/payment-core/zod';

import { hydraSnapshotUtxoSchema } from './schemas';

export type HydraFanoutRemainingUtxo = z.infer<typeof hydraSnapshotUtxoSchema>;

/**
 * `FanoutMode` in `Hydra/HeadLogic/State.hs`. Only `AwaitingSelection` waits
 * for a selection: in the other two the node posts the next step itself.
 */
export const HYDRA_FANOUT_MODES = ['AutoDrain', 'DistributingSelection', 'AwaitingSelection'] as const;
export type HydraFanoutMode = (typeof HYDRA_FANOUT_MODES)[number];

export type HydraFanoutHeadState = {
	/** Null before the first fanout step. */
	mode: HydraFanoutMode | null;
	selectable: HydraFanoutRemainingUtxo;
};

const snapshotVersionSchema = z.number().int().nonnegative();

const confirmedSnapshotSchema = z.discriminatedUnion('tag', [
	// The head closed on its initial snapshot, which holds nothing.
	z.looseObject({ tag: z.literal('InitialSnapshot') }),
	z.looseObject({
		tag: z.literal('ConfirmedSnapshot'),
		snapshot: z.looseObject({
			version: snapshotVersionSchema,
			utxo: hydraSnapshotUtxoSchema,
			utxoToCommit: hydraSnapshotUtxoSchema.nullish(),
			utxoToDecommit: hydraSnapshotUtxoSchema.nullish(),
		}),
	}),
]);

const fanoutHeadStateSchema = z.discriminatedUnion('tag', [
	z.looseObject({
		tag: z.literal('Closed'),
		contents: z.looseObject({ confirmedSnapshot: confirmedSnapshotSchema, version: snapshotVersionSchema }),
	}),
	z.looseObject({
		tag: z.literal('FanoutProgress'),
		contents: z.looseObject({
			remainingOutputs: hydraSnapshotUtxoSchema,
			mode: z.looseObject({ tag: z.enum(HYDRA_FANOUT_MODES) }),
		}),
	}),
]);

export class HydraFanoutHeadStateError extends Error {}

/**
 * The fanout state of a closed head, or null when the node does not hold the
 * head as closed. Throws `HydraFanoutHeadStateError` for a closed head whose
 * state this code cannot read.
 */
export function parseFanoutHeadState(headState: unknown): HydraFanoutHeadState | null {
	const tag = typeof headState === 'object' && headState != null ? (headState as { tag?: unknown }).tag : undefined;
	if (tag !== 'Closed' && tag !== 'FanoutProgress') return null;
	const parsed = fanoutHeadStateSchema.safeParse(headState);
	if (!parsed.success) throw new HydraFanoutHeadStateError(`The node returned an unreadable ${tag} head state`);

	const state = parsed.data;
	if (state.tag === 'FanoutProgress') {
		return { mode: state.contents.mode.tag, selectable: state.contents.remainingOutputs };
	}
	const confirmed = state.contents.confirmedSnapshot;
	if (confirmed.tag === 'InitialSnapshot') return { mode: null, selectable: {} };
	const { snapshot } = confirmed;
	const isSnapshotOnChainVersion = snapshot.version === state.contents.version;
	return {
		mode: null,
		selectable: {
			...snapshot.utxo,
			...(isSnapshotOnChainVersion ? {} : (snapshot.utxoToCommit ?? {})),
			...(isSnapshotOnChainVersion ? (snapshot.utxoToDecommit ?? {}) : {}),
		},
	};
}
