/**
 * Noticing when hydra-node starts saying something we do not model.
 *
 * The transition check can only account for state it knows about, and twice now
 * a field it did not model has taken a head down completely: a decommit
 * carrying its own L1 fee, and a deposit recovered instead of absorbed. Both
 * were legitimate protocol behaviour, both were signed by every party, and both
 * presented as an endless reconnect loop naming nothing.
 *
 * Our schemas are deliberately permissive — `z.looseObject` everywhere on the
 * replay path, so an added field never breaks a running head over a shape we
 * could have ignored.
 * The cost of that permissiveness is silence: a new partition would be dropped
 * on the floor and only surface later as a rejected history. This restores the
 * signal without the brittleness. It reports; it never refuses.
 *
 * The node reports no version over its API, so this watches the shape itself,
 * which is the thing that actually matters.
 *
 * See docs/adr/0012-hydra-snapshot-verification-and-upgrades.md.
 */

/**
 * Every field a `SnapshotConfirmed` snapshot is known to carry.
 *
 * Observed on hydra-node 2.3. Adding one here is a claim that the transition
 * check either accounts for it or is safe to ignore it — so the enumerated
 * shapes in transition-shapes.spec.ts should grow at the same time.
 */
export const MODELLED_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set([
	'accumulator',
	'confirmed',
	'headId',
	'number',
	'utxo',
	'utxoToCommit',
	'utxoToDecommit',
	'version',
]);

/**
 * Every field a single UTxO output is known to carry.
 *
 * Covered separately because outputs are where an addition is most likely and
 * least visible: they are nested two levels down inside three partitions, and
 * the accumulator only sees them as serialized bytes. `referenceScript`'s own
 * inner fields are deliberately not walked — a change there shows up as a
 * different serialization, which the accumulator check already reports.
 */
export const MODELLED_SNAPSHOT_OUTPUT_FIELDS: ReadonlySet<string> = new Set([
	'address',
	'datum',
	'datumhash',
	'inlineDatum',
	'inlineDatumRaw',
	'inlineDatumhash',
	'referenceScript',
	'value',
]);

/** The snapshot partitions whose values are UTxO outputs. */
const SNAPSHOT_OUTPUT_PARTITIONS: readonly string[] = ['utxo', 'utxoToCommit', 'utxoToDecommit'];

/** Every field the frame around it is known to carry. */
export const MODELLED_SNAPSHOT_FRAME_FIELDS: ReadonlySet<string> = new Set([
	'headId',
	'seq',
	'signatures',
	'snapshot',
	'tag',
	'timestamp',
]);

export type ProtocolDrift = {
	/** Where the unknown fields appeared, for the operator-facing message. */
	location: 'snapshot' | 'frame' | 'output';
	fields: string[];
};

/** `Object.entries` for a value of unknown shape, with the key/value pair typed. */
function entriesOf(value: unknown): Array<[string, unknown]> {
	if (typeof value !== 'object' || value === null) return [];
	return Object.entries(value) as Array<[string, unknown]>;
}

function unknownFields(value: unknown, modelled: ReadonlySet<string>): string[] {
	if (typeof value !== 'object' || value === null) return [];
	return Object.keys(value).filter((field) => !modelled.has(field));
}

/**
 * Fields in a SnapshotConfirmed frame that this service does not model.
 *
 * Empty for every frame Hydra 2.3 produces. A non-empty result means the node
 * was upgraded, or reached a state we have never seen, and that the transition
 * check should be reviewed BEFORE it rejects a history in production.
 */
export function detectSnapshotDrift(message: unknown): ProtocolDrift[] {
	if (typeof message !== 'object' || message === null) return [];
	const frame = message as { snapshot?: unknown };
	const drift: ProtocolDrift[] = [];

	const frameFields = unknownFields(frame, MODELLED_SNAPSHOT_FRAME_FIELDS);
	if (frameFields.length > 0) drift.push({ location: 'frame', fields: frameFields });

	const snapshotFields = unknownFields(frame.snapshot, MODELLED_SNAPSHOT_FIELDS);
	if (snapshotFields.length > 0) drift.push({ location: 'snapshot', fields: snapshotFields });

	const outputFields = new Set<string>();
	// Walked by entry rather than indexed by partition name, so nothing here needs
	// an unknown-valued map type to read a JSON object of unknown shape.
	for (const [partition, outputs] of entriesOf(frame.snapshot)) {
		if (!SNAPSHOT_OUTPUT_PARTITIONS.includes(partition)) continue;
		for (const [, output] of entriesOf(outputs)) {
			for (const field of unknownFields(output, MODELLED_SNAPSHOT_OUTPUT_FIELDS)) {
				outputFields.add(field);
			}
		}
	}
	// Deduped across every output and partition: one added field would otherwise
	// be named once per UTxO, and a snapshot carries up to 4095 of them.
	if (outputFields.size > 0) drift.push({ location: 'output', fields: [...outputFields].sort() });

	return drift;
}

/** One operator-facing line naming what changed and what to do about it. */
export function describeProtocolDrift(drift: readonly ProtocolDrift[]): string {
	const parts = drift.map((entry) => `${entry.location}: ${entry.fields.join(', ')}`);
	return (
		`This hydra-node reports snapshot fields this service does not model (${parts.join('; ')}). ` +
		'Nothing is broken yet and the head keeps running, but the signed-state check cannot account for state it ' +
		'does not know about, which is how a legitimate withdrawal previously took a head offline. ' +
		'See docs/adr/0012-hydra-snapshot-verification-and-upgrades.md before upgrading further.'
	);
}
