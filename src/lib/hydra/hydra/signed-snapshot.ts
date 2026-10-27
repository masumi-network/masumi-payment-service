import type { z } from '@masumi/payment-core/zod';
import type { snapshotConfirmedMessageSchema } from './schemas';

type SnapshotConfirmedMessage = z.output<typeof snapshotConfirmedMessageSchema>;

/**
 * A snapshot every head party signed, in the `ConfirmedSnapshot` shape that
 * hydra-node serves on `GET /snapshot` and accepts on `POST /snapshot`.
 */
export type HydraConfirmedSnapshotPayload = {
	tag: 'ConfirmedSnapshot';
	snapshot: SnapshotConfirmedMessage['snapshot'];
	signatures: SnapshotConfirmedMessage['signatures'];
};

export function toConfirmedSnapshotPayload(message: SnapshotConfirmedMessage): HydraConfirmedSnapshotPayload {
	return { tag: 'ConfirmedSnapshot', snapshot: message.snapshot, signatures: message.signatures };
}
