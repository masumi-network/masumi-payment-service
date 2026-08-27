import { z } from '@masumi/payment-core/zod';

import { HydraScriptLanguage, HydraTransactionType } from './types';
import { HydraHeadStatus } from '@/generated/prisma/client';

export const MAX_HYDRA_WS_FRAME_BYTES = 4 * 1024 * 1024;
// Mainnet's maxTxSize is normally 16 KiB. Allow protocol-parameter headroom,
// but reject payloads large enough to turn retained confirmation evidence into
// an easy memory-exhaustion primitive.
const MAX_HYDRA_TRANSACTION_CBOR_HEX_LENGTH = 128 * 1024;
const MAX_HYDRA_TRANSACTION_DESCRIPTION_LENGTH = 1024;
const MAX_HYDRA_CONFIRMED_TRANSACTIONS_PER_FRAME = 1024;
export const MAX_HYDRA_SNAPSHOT_OUTPUTS = 4095;

const boundedTagSchema = z.string().min(1).max(64);
const boundedHeadIdSchema = z.string().min(1).max(128);
const boundedTransactionIdSchema = z.string().min(1).max(128);
export const canonicalHydraHeadIdSchema = z
	.string()
	.regex(/^[0-9a-fA-F]{56}$/, 'Hydra head id must be a 28-byte hexadecimal value')
	.transform((id) => id.toLowerCase());
export const canonicalHydraTransactionIdSchema = z
	.string()
	.regex(/^[0-9a-fA-F]{64}$/)
	.transform((id) => id.toLowerCase());
const hydraCborHexSchema = z
	.string()
	.min(2)
	.max(MAX_HYDRA_TRANSACTION_CBOR_HEX_LENGTH)
	.regex(/^(?:[0-9a-fA-F]{2})+$/, 'cborHex must be non-empty, even-length hexadecimal');

export const messageSchema = z.looseObject({
	tag: boundedTagSchema,
	headStatus: z.string().max(64).optional(),
	headId: boundedHeadIdSchema.optional(),
	hydraHeadId: boundedHeadIdSchema.nullable().optional(),
	snapshotNumber: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	contestationDeadline: z.string().max(128).optional(),
});

export const hydraHeadStatusSchema = z.enum(Object.values(HydraHeadStatus));

// Loose, unlike the command envelope below. This one describes what a head
// *sends* us — inside every replayed `SnapshotConfirmed` — and only `cborHex`
// and `txId` are ever read off it. Refusing an envelope over a field a newer
// hydra-node added would reject the same replayed frame on every reconnect and
// take the head's whole L2 surface down, which is the outage `protocol-drift`
// exists to avoid. The command envelope stays strict because we author it.
export const hydraTransactionSchema = z.looseObject({
	type: z.enum(HydraTransactionType),
	cborHex: hydraCborHexSchema,
	description: z.string().max(MAX_HYDRA_TRANSACTION_DESCRIPTION_LENGTH),
	// Exact 32-byte/hash agreement is enforced before cache/event mutation. Keep
	// this bounded schema tolerant of older hydra-node test/dev identifiers so a
	// malformed id produces one redacted protocol error at that trust boundary.
	txId: boundedTransactionIdSchema,
});

export const hydraCommandTransactionSchema = z.strictObject({
	type: z.enum(HydraTransactionType),
	cborHex: hydraCborHexSchema,
	description: z.string().max(MAX_HYDRA_TRANSACTION_DESCRIPTION_LENGTH),
	txId: boundedTransactionIdSchema.optional(),
});

const timedServerOutputSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
	headId: canonicalHydraHeadIdSchema.optional(),
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
	chainTime: z.string().max(128),
	chainSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const txValidMessageSchema = z.looseObject({
	tag: z.literal('TxValid'),
	transactionId: canonicalHydraTransactionIdSchema,
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

export const txInvalidMessageSchema = z.looseObject({
	tag: z.literal('TxInvalid'),
	transaction: hydraTransactionSchema,
	/**
	 * Why the head refused it, in the ledger's own words.
	 *
	 * Bounded and optional because it is diagnostic text from another process:
	 * it must never be trusted for control flow, and a node that omits it or
	 * sends something unexpected must not fail the frame. It is worth carrying
	 * because "Transaction is invalid" on its own leaves an operator with no way
	 * to tell a race from a bug — the difference between "retry" and "escalate".
	 */
	validationError: z
		.looseObject({
			reason: z.string().max(2000).optional(),
		})
		.optional(),
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

export const commandFailedMessageSchema = z.looseObject({
	tag: z.literal('CommandFailed'),
	clientInput: z
		.looseObject({
			tag: boundedTagSchema,
			transaction: hydraCommandTransactionSchema.optional(),
		})
		.optional(),
	headId: canonicalHydraHeadIdSchema.optional(),
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

/**
 * The head signed a snapshot that removes a withdrawal's outputs.
 *
 * The moment that matters: from here the value is out of the head, and the only
 * question left is when L1 receives it. Anything watching a withdrawal has to
 * treat this as the point of no return rather than waiting for finalization.
 */
export const decommitApprovedMessageSchema = z.looseObject({
	tag: z.literal('DecommitApproved'),
	decommitTxId: canonicalHydraTransactionIdSchema,
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

/**
 * A deposit the head has seen on chain, and the deadline it will hold it to.
 *
 * The deadline is written into the deposit datum by whichever node drafted the
 * deposit, from that node's own chain time. Nothing this service holds can
 * reproduce it — not the transaction's validity interval, not the time the
 * operator asked for the top-up — so this frame is the only place it can be
 * learned. `pendingDeposit` is the deposit transaction's id, which is what ties
 * it back to a HydraTopup row.
 */
export const commitRecordedMessageSchema = z.looseObject({
	tag: z.literal('CommitRecorded'),
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
	pendingDeposit: canonicalHydraTransactionIdSchema,
	deadline: z.string().min(1),
});

/**
 * An output's value as a head reports it.
 *
 * Lovelace sits at the top level under its own name; every other key is a policy
 * id whose value maps asset name to quantity. Quantities arrive as JSON numbers,
 * so they are accepted as numbers or strings and converted to BigInt by the
 * caller rather than being trusted as JavaScript numbers.
 *
 * `bigint` belongs in that union for the same reason it does in
 * `hydraQuantitySchema`: frames are parsed by json-bigint, which hands back a
 * native bigint for any integer literal at or above 1e15 — one billion units of
 * an ordinary six-decimal token. Without it, a large enough decommit makes
 * `DecommitFinalized` unparseable, and since the history socket replays from the
 * beginning on every reconnect, that one frame rejects forever and takes every
 * L2 operation on the head down with it.
 */
const hydraAssetQuantitySchema = z.union([z.number(), z.string(), z.bigint()]);
const hydraOutputValueSchema = z.record(
	z.string(),
	z.union([hydraAssetQuantitySchema, z.record(z.string(), hydraAssetQuantitySchema)]),
);

/**
 * The node observed its own L1 decrement, so the funds are spendable on L1.
 *
 * Deliberately does NOT require `decommitTxId`: unlike DecommitApproved, this
 * message does not carry one. Requiring it made every finalization fail to
 * parse, which left settled withdrawals reading as still paying out forever.
 *
 * What it does carry is `distributedUTxO` — what landed, keyed by the in-head
 * reference of the output that was removed. That reference names a transaction
 * that only ever existed inside the head, so it is a description of the value
 * rather than a chain-explorer link.
 */
export const decommitFinalizedMessageSchema = z.looseObject({
	tag: z.literal('DecommitFinalized'),
	decommitTxId: canonicalHydraTransactionIdSchema.optional(),
	distributedUTxO: z
		.record(z.string(), z.looseObject({ address: z.string(), value: hydraOutputValueSchema }))
		.optional(),
	/**
	 * When the head produced this. Load-bearing, not decoration: the whole
	 * history replays on every reconnection, so an old finalization must not be
	 * attributed to a withdrawal that was requested after it.
	 */
	timestamp: z.string().optional(),
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

/**
 * A withdrawal the head has taken in, with the transaction that performs it.
 *
 * The transaction matters beyond bookkeeping: it is the only thing that
 * explains the state change the following snapshot signs. A decommit is a real
 * Cardano transaction with a real L1 fee, and it is reported here rather than in
 * the snapshot's `confirmed` list, so a conservation check that walks only
 * `confirmed` sees value change with nothing to account for it.
 */
export const decommitRequestedMessageSchema = z.looseObject({
	tag: z.literal('DecommitRequested'),
	decommitTx: hydraTransactionSchema,
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

/**
 * The head refused a withdrawal. Nothing left the head.
 *
 * The transaction rather than its id, because the node reports the body it
 * rejected — matching it back to a request means hashing that body, exactly as
 * TxInvalid is handled.
 */
export const decommitInvalidMessageSchema = z.looseObject({
	tag: z.literal('DecommitInvalid'),
	decommitTx: hydraTransactionSchema,
	/** Kept verbatim and never used for control flow, as with TxInvalid. */
	decommitInvalidReason: z.unknown().optional(),
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

export const postTxOnChainFailedMessageSchema = z.looseObject({
	tag: z.literal('PostTxOnChainFailed'),
	postChainTx: z.looseObject({ tag: boundedTagSchema }).optional(),
	postTxError: z.unknown().optional(),
	headId: canonicalHydraHeadIdSchema.optional(),
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
});

export const MAX_HYDRA_QUANTITY = (1n << 64n) - 1n;
const hydraQuantitySchema = z
	.union([z.number().int().nonnegative().finite().max(Number.MAX_SAFE_INTEGER), z.bigint().nonnegative()])
	.transform((quantity) => BigInt(quantity))
	.refine((quantity) => quantity <= MAX_HYDRA_QUANTITY, 'Hydra quantity exceeded the Cardano uint64 range');
const hydraAssetMapSchema = z
	.record(z.string().max(128), hydraQuantitySchema)
	.refine((assets) => Object.keys(assets).length <= 1024, 'Hydra asset map exceeded 1024 entries');
const hydraValueSchema = z
	.record(z.string().min(1).max(128), z.union([hydraQuantitySchema, hydraAssetMapSchema]))
	.refine((value) => Object.keys(value).length <= 256, 'Hydra value exceeded 256 policy entries');
// Loose, like every other replay-path schema, and for the reason
// protocol-drift.ts states: an added field must not break a running head over a
// shape we could have ignored. Strictness bought nothing here — a field that
// changes the output's serialized bytes fails the accumulator check anyway, and
// a field that does not is cosmetic — while costing the worst failure this
// codebase has: history replays from the start on every reconnect, so one
// rejected frame is rejected forever, and a head with no verified session has
// no clock and fails every L2 escrow operation closed. Renames are still
// caught: the fields below stay required.
const hydraReferenceScriptSchema = z.looseObject({
	scriptLanguage: z.string().min(1).max(64),
	script: z.looseObject({
		cborHex: hydraCborHexSchema,
		description: z.string().max(MAX_HYDRA_TRANSACTION_DESCRIPTION_LENGTH),
		type: z.enum(HydraScriptLanguage),
	}),
});
const hydraSnapshotOutputReferenceSchema = z
	.string()
	.max(96)
	.regex(/^[0-9a-fA-F]{64}#[0-9]+$/)
	.refine((reference) => Number(reference.slice(reference.indexOf('#') + 1)) <= 0xffffffff, {
		message: 'Hydra output reference index must fit uint32',
	});
const nullableBoundedHexSchema = z
	.string()
	.max(128 * 1024)
	.regex(/^(?:[0-9a-fA-F]{2})*$/, 'value must be even-length hexadecimal')
	.nullable();
// Loose for the same reason as hydraReferenceScriptSchema above.
// `detectSnapshotDrift` covers these keys, so an addition is still reported to
// the operator before it can matter — it just no longer takes the head down.
const hydraSnapshotOutputSchema = z.looseObject({
	address: z.string().min(1).max(256),
	value: hydraValueSchema,
	referenceScript: hydraReferenceScriptSchema.nullable(),
	datumhash: z
		.string()
		.regex(/^[0-9a-fA-F]{64}$/)
		.nullable()
		.optional(),
	inlineDatumhash: z
		.string()
		.regex(/^[0-9a-fA-F]{64}$/)
		.nullable()
		.optional(),
	inlineDatum: z.unknown().nullable(),
	inlineDatumRaw: nullableBoundedHexSchema,
	datum: nullableBoundedHexSchema,
});

export const hydraSnapshotUtxoSchema = z
	.record(hydraSnapshotOutputReferenceSchema, hydraSnapshotOutputSchema)
	.refine(
		(utxos) => Object.keys(utxos).length <= MAX_HYDRA_SNAPSHOT_OUTPUTS,
		`Hydra snapshot exceeded ${MAX_HYDRA_SNAPSHOT_OUTPUTS} outputs`,
	);

// Loose, like the rest of the replay path: an added sibling field must not wedge
// a running head, and the vkey below stays required so a rename is still caught.
const hydraPartySchema = z.looseObject({
	vkey: z
		.string()
		.regex(/^[0-9a-fA-F]{64}$/, 'Hydra party key must be a raw 32-byte verification key')
		.transform((key) => key.toLowerCase()),
});

export const headPartiesMessageSchema = z.looseObject({
	tag: z.enum(['HeadIsInitializing', 'HeadIsOpen']),
	headId: canonicalHydraHeadIdSchema,
	parties: z.array(hydraPartySchema).min(1).max(128),
});

export const historyHeadIsOpenMessageSchema = z.looseObject({
	tag: z.literal('HeadIsOpen'),
	headId: canonicalHydraHeadIdSchema,
	// `.nullish()`, like every other Maybe field here. A Haskell `Maybe` absent
	// from the wire and one serialized as `null` are the same value, and this node
	// demonstrably emits the null form (`hydraHeadId` everywhere). Modelled as
	// merely required, a `utxo: null` threw — and on the replay path a throw is
	// permanent: history replays from the beginning on every reconnect, so the
	// same frame is rejected forever and the head never gets a verified session.
	utxo: hydraSnapshotUtxoSchema.nullish(),
});

/**
 * The head's confirmed ledger, as the end-of-history marker reports it.
 *
 * Hydra 2.3 does not put the opening UTxO set on `HeadIsOpen` any more — that
 * frame carries only `headId`, `parties` and `seq` — and reports the current
 * confirmed set on `Greetings.snapshotUtxo` instead. It is the only place a
 * head that has not yet signed a snapshot states its ledger at all, so without
 * it such a head has no state anchor and never forms a live session.
 *
 * Optional, because a node too old to send it is answered by the `HeadIsOpen`
 * path above, and because an anchor is only required for the head statuses in
 * HISTORY_STATUS_REQUIRING_STATE_ANCHOR.
 */
export const greetingsSnapshotMessageSchema = z.looseObject({
	tag: z.literal('Greetings'),
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
	// `.nullish()` for the same reason as historyHeadIsOpenMessageSchema.utxo.
	snapshotUtxo: hydraSnapshotUtxoSchema.nullish(),
});

/**
 * `HeadIsFinalized.utxo` comes from hydra-node's chain observer. Its keys are
 * the actual L1 fanout transaction outputs (`txHash#index`), not the former L2
 * references. Callers must still compare the complete serialized TxOut
 * multiset with the signature-verified final snapshot before trusting it.
 */
/**
 * The head's final L1 state, as the node observed it.
 *
 * The field was called `utxo` until Hydra 2.2.0 renamed it to `finalizedUTxO`,
 * which is what 2.3.0 sends. Both are accepted and normalised onto one name:
 * reading only the old one meant the map was never recorded on a current node,
 * and the map is what binds each in-head escrow to the L1 output that replaced
 * it. Without it no closed head can ever finish reconciling.
 *
 * The shape did not change with the rename — still a map keyed by `txId#index`.
 */
export const headIsFinalizedMessageSchema = z
	.looseObject({
		tag: z.literal('HeadIsFinalized'),
		headId: canonicalHydraHeadIdSchema,
		// `.nullish()` on both: the rename left `utxo` in place as a legacy field,
		// which is exactly the kind a node emits as an explicit null.
		utxo: hydraSnapshotUtxoSchema.nullish(),
		finalizedUTxO: hydraSnapshotUtxoSchema.nullish(),
	})
	.refine((message) => message.finalizedUTxO != null || message.utxo != null, {
		message: 'HeadIsFinalized carried no finalized UTxO map under either field name',
	});

/** The finalized map, whichever name the node used for it. */
export function finalizedUtxoOf(
	message: z.infer<typeof headIsFinalizedMessageSchema>,
): NonNullable<z.infer<typeof headIsFinalizedMessageSchema>['finalizedUTxO']> {
	const finalized = message.finalizedUTxO ?? message.utxo;
	if (finalized == null) {
		// Unreachable through the schema, which refuses a message carrying neither.
		throw new Error('HeadIsFinalized carried no finalized UTxO map');
	}
	return finalized;
}

/** Whether a frame carries a finalized UTxO map under either field name. */
export function hasFinalizedUtxoField(message: unknown): boolean {
	// A VALUE test, not `'x' in message`. `in` is true for `{ utxo: null }`, so a
	// frame carrying the legacy field as an explicit null passed this guard and
	// then threw inside the parse — permanently, on the replay path, and on the
	// live path silently leaving `status` at Open so the head was never recorded
	// Final and its fanout map never captured.
	if (typeof message !== 'object' || message === null) return false;
	const frame = message as { finalizedUTxO?: unknown; utxo?: unknown };
	return frame.finalizedUTxO != null || frame.utxo != null;
}

export const greetingsIdentityMessageSchema = z.looseObject({
	tag: z.literal('Greetings'),
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
	me: hydraPartySchema,
	env: z.looseObject({
		party: hydraPartySchema,
		otherParties: z.array(hydraPartySchema).max(127),
	}),
});

const snapshotSignatureSchema = z
	.string()
	.regex(/^[0-9a-fA-F]{128}$/, 'Hydra snapshot signature must be a raw 64-byte Ed25519 signature')
	.transform((signature) => signature.toLowerCase());

export const snapshotConfirmedMessageSchema = z.looseObject({
	tag: z.literal('SnapshotConfirmed'),
	seq: timedServerOutputSequenceSchema.optional(),
	headId: canonicalHydraHeadIdSchema,
	hydraHeadId: canonicalHydraHeadIdSchema.nullable().optional(),
	// TimedServerOutput serializes its Haskell `time` field as the top-level
	// JSON key `timestamp`. Missing timestamps fail closed during reconciliation.
	timestamp: z.string().max(128).optional(),
	// Loose for the same reason. The signatures themselves are checked against the
	// party keys, so an unmodelled sibling field cannot weaken that.
	signatures: z.looseObject({
		multiSignature: z.array(snapshotSignatureSchema).min(1).max(128),
	}),
	snapshot: z.looseObject({
		headId: canonicalHydraHeadIdSchema,
		version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		number: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		accumulator: z
			.string()
			.regex(/^[0-9a-fA-F]{64}$/)
			.transform((value) => value.toLowerCase()),
		confirmed: z.array(hydraTransactionSchema).max(MAX_HYDRA_CONFIRMED_TRANSACTIONS_PER_FRAME),
		utxo: hydraSnapshotUtxoSchema,
		utxoToCommit: hydraSnapshotUtxoSchema.nullable(),
		utxoToDecommit: hydraSnapshotUtxoSchema.nullable(),
	}),
});

export const historySnapshotConfirmedMessageSchema = snapshotConfirmedMessageSchema.extend({
	// History reconciliation requires the wire sequence. Without it, replayed
	// and concurrently observed live confirmations cannot be ordered safely.
	seq: timedServerOutputSequenceSchema,
});

const boundedProtocolIntegerSchema = z.number().int().nonnegative().finite().max(Number.MAX_SAFE_INTEGER);
const boundedProtocolNumberSchema = z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER);

/**
 * Loose for the same reason the object around it is.
 *
 * These were strict, which meant an additive change upstream — an era-specific
 * unit, a new price field — made the whole parameter fetch throw, and every L2
 * transaction build on the head fails with it until the schema is patched. The
 * fields that are read are pinned by being named; a field that is not read
 * cannot break anything by existing.
 */
const executionUnitsSchema = z.looseObject({
	memory: boundedProtocolIntegerSchema,
	steps: boundedProtocolIntegerSchema,
});

export const hydraProtocolParametersSchema = z.looseObject({
	utxoCostPerByte: boundedProtocolIntegerSchema,
	collateralPercentage: boundedProtocolIntegerSchema,
	maxBlockExecutionUnits: executionUnitsSchema,
	maxBlockHeaderSize: boundedProtocolIntegerSchema,
	maxBlockBodySize: boundedProtocolIntegerSchema,
	maxCollateralInputs: boundedProtocolIntegerSchema,
	maxTxExecutionUnits: executionUnitsSchema,
	maxTxSize: boundedProtocolIntegerSchema,
	maxValueSize: boundedProtocolIntegerSchema,
	txFeePerByte: boundedProtocolIntegerSchema,
	txFeeFixed: boundedProtocolIntegerSchema,
	minPoolCost: boundedProtocolIntegerSchema,
	stakePoolDeposit: boundedProtocolIntegerSchema,
	executionUnitPrices: z.looseObject({
		priceMemory: boundedProtocolNumberSchema,
		priceSteps: boundedProtocolNumberSchema,
	}),
});

export const hydraCostModelSchema = z
	.array(z.union([z.number(), z.string().regex(/^-?[0-9]+$/)]))
	.max(512)
	.transform((entries, context) => {
		const values = entries.map(Number);
		if (values.some((value) => !Number.isSafeInteger(value))) {
			context.addIssue({ code: 'custom', message: 'Cost model entries must be safe integers' });
			return z.NEVER;
		}
		return values;
	});

export const hydraCostModelsEnvelopeSchema = z.looseObject({
	costModels: z
		.looseObject({
			PlutusV1: z.unknown().optional(),
			PlutusV2: z.unknown().optional(),
			PlutusV3: z.unknown().optional(),
		})
		.optional(),
});
