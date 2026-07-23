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

export const hydraTransactionSchema = z.strictObject({
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
const hydraReferenceScriptSchema = z.strictObject({
	scriptLanguage: z.string().min(1).max(64),
	script: z.strictObject({
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
const hydraSnapshotOutputSchema = z.strictObject({
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

const hydraPartySchema = z.strictObject({
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
	utxo: hydraSnapshotUtxoSchema,
});

/**
 * `HeadIsFinalized.utxo` comes from hydra-node's chain observer. Its keys are
 * the actual L1 fanout transaction outputs (`txHash#index`), not the former L2
 * references. Callers must still compare the complete serialized TxOut
 * multiset with the signature-verified final snapshot before trusting it.
 */
export const headIsFinalizedMessageSchema = z.looseObject({
	tag: z.literal('HeadIsFinalized'),
	headId: canonicalHydraHeadIdSchema,
	utxo: hydraSnapshotUtxoSchema,
});

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
	signatures: z.strictObject({
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

export const hydraProtocolParametersSchema = z.looseObject({
	utxoCostPerByte: boundedProtocolIntegerSchema,
	collateralPercentage: boundedProtocolIntegerSchema,
	maxBlockExecutionUnits: z.strictObject({
		memory: boundedProtocolIntegerSchema,
		steps: boundedProtocolIntegerSchema,
	}),
	maxBlockHeaderSize: boundedProtocolIntegerSchema,
	maxBlockBodySize: boundedProtocolIntegerSchema,
	maxCollateralInputs: boundedProtocolIntegerSchema,
	maxTxExecutionUnits: z.strictObject({
		memory: boundedProtocolIntegerSchema,
		steps: boundedProtocolIntegerSchema,
	}),
	maxTxSize: boundedProtocolIntegerSchema,
	maxValueSize: boundedProtocolIntegerSchema,
	txFeePerByte: boundedProtocolIntegerSchema,
	txFeeFixed: boundedProtocolIntegerSchema,
	minPoolCost: boundedProtocolIntegerSchema,
	stakePoolDeposit: boundedProtocolIntegerSchema,
	executionUnitPrices: z.strictObject({
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
