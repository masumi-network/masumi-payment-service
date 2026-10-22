import { HydraHeadStatus } from '@/generated/prisma/client';
import { parseBoundedJsonFrame } from './node-frames';
import { hydraHeadStatusSchema, messageSchema } from './schemas';

/**
 * Was this buffered page written by a node that had no head yet?
 *
 * Greetings closes a history page and states the node's status as it stood
 * then, so an Idle one carrying no head id is proof rather than a violation —
 * the same reading the live session already gives it, where returning to Idle
 * is a legitimate rollback through Init rather than a protocol breach.
 *
 * Scoped to the flush deliberately. Frames are only buffered while no head is
 * pinned, and nothing unpins one, so this cannot fire twice and the restart it
 * asks for cannot loop. A pinned pass that reaches Idle is a different
 * question — a head this service believes in that its node no longer sees —
 * and still fails closed.
 */
export function pageClosedBeforeHeadExisted(frames: readonly string[]): boolean {
	for (const frame of frames) {
		let message: unknown;
		try {
			message = parseBoundedJsonFrame(frame);
		} catch {
			// Malformed: let the normal pass report it with its own message.
			return false;
		}
		const envelope = messageSchema.safeParse(message);
		if (!envelope.success || envelope.data.tag !== 'Greetings') continue;
		if (envelope.data.headId != null || envelope.data.hydraHeadId != null) continue;
		const status = hydraHeadStatusSchema.safeParse(envelope.data.headStatus);
		if (status.success && status.data === HydraHeadStatus.Idle) return true;
	}
	return false;
}
