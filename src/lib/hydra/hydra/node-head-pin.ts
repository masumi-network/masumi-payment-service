import { HydraProtocolError } from './errors';
import { canonicalHydraHeadIdSchema } from './schemas';

type PinnedHeadIds = {
	expectedHeadId: string | undefined;
	liveSessionHeadId: string | undefined;
	replaySessionHeadId: string | undefined;
};

/**
 * The canonical form of `headId`, ready to pin. Throws when it is malformed, or
 * when a different head is already pinned or verified on either websocket.
 */
export function resolvePinnableHeadId(headId: string, pinned: PinnedHeadIds): string {
	const parsedHeadId = canonicalHydraHeadIdSchema.safeParse(headId);
	if (!parsedHeadId.success) {
		throw new HydraProtocolError('Hydra head id must be a 28-byte hexadecimal value');
	}
	if (pinned.expectedHeadId && pinned.expectedHeadId !== parsedHeadId.data) {
		throw new HydraProtocolError(
			`Hydra head id mismatch: expected ${pinned.expectedHeadId}, received ${parsedHeadId.data}`,
		);
	}
	if (
		(pinned.liveSessionHeadId && pinned.liveSessionHeadId !== parsedHeadId.data) ||
		(pinned.replaySessionHeadId && pinned.replaySessionHeadId !== parsedHeadId.data)
	) {
		throw new HydraProtocolError('Hydra head id did not match the already verified websocket sessions');
	}
	return parsedHeadId.data;
}
