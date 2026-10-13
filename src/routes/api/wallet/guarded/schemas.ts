import { z } from '@masumi/payment-core/zod';

const MAX_QUORUM_SIZE = 16;
const keyHash = z
	.string()
	.regex(/^[0-9a-f]{56}$/, '28-byte hex key hash')
	.describe('Quorum member key hash (28-byte hex)');
const minorUnits = z
	.string()
	.regex(/^\d+$/, 'an integer of minor units')
	.describe('Amount in minor units of the governed asset (lovelace for ADA)');
const assetId = z
	.string()
	.regex(/^(lovelace|[0-9a-f]{56}\.([0-9a-f]{2}){0,32})$/, 'lovelace or <policy>.<nameHex>')
	.describe('Exchain asset id: lovelace or <policy>.<nameHex>');
const exchainWalletId = z
	.string()
	.regex(/^wal_[0-9A-HJKMNP-TV-Z]{26}$/, 'wal_ followed by 26 ULID characters')
	.describe('Exchain wallet id (wal_...)');

export const guardedWalletMandateSchema = z
	.object({
		perTxCap: minorUnits.describe('Largest single lock Exchain co-signs, in minor units of the governed asset'),
		daily: minorUnits.describe(
			"Daily limit, in minor units of the governed asset. Must equal the wallet's on-chain period limit for it",
		),
		perSeller: minorUnits.describe('Daily limit per seller, in minor units of the governed asset'),
		perAgent: minorUnits.describe('Daily limit per agent, in minor units of the governed asset'),
		envelope: minorUnits.describe('Lifetime limit, in minor units of the governed asset'),
		burstPerMinute: z.number().int().min(1).describe('Most payments Exchain co-signs per minute'),
	})
	.describe('The mandate Exchain enforces. It cannot change once registered');

export const postGuardedWalletSchemaInput = z
	.object({
		hotWalletId: z.string().min(1).describe('The Purchasing hot wallet whose key is the smart wallet agent'),
		ownerAddress: z.string().min(1).max(200).describe("The owner's base address. The owner key never reaches the node"),
		quorumVkhs: z.array(keyHash).min(1).max(MAX_QUORUM_SIZE).describe('Quorum key hashes baked into the script'),
		threshold: z.number().int().min(1).max(MAX_QUORUM_SIZE).describe('How many quorum keys must sign'),
		stateTokenName: z
			.string()
			.regex(/^[0-9a-f]{64}$/, '32-byte hex')
			.describe('Asset name of the wallet state token (32-byte hex)'),
		governedAsset: assetId
			.default('lovelace')
			.describe(
				'The one asset agents pay in: lovelace, or USDM / USDCx where the network has it. The on-chain limit must list it',
			),
		exchainWalletId: exchainWalletId.optional().describe('Set when the wallet is already registered with Exchain'),
		register: z
			.object({ mandate: guardedWalletMandateSchema })
			.optional()
			.describe('Register the wallet with Exchain now, with this mandate'),
	})
	.refine((input) => input.threshold <= input.quorumVkhs.length, {
		message: 'threshold cannot exceed the number of quorum keys',
		path: ['threshold'],
	})
	.refine((input) => new Set(input.quorumVkhs).size === input.quorumVkhs.length, {
		message: 'quorumVkhs repeats a key',
		path: ['quorumVkhs'],
	})
	.refine((input) => input.exchainWalletId == null || input.register == null, {
		message: 'pass exchainWalletId or register, not both',
		path: ['register'],
	})
	.refine((input) => input.governedAsset === 'lovelace' || input.exchainWalletId == null, {
		// The node cannot read back which asset an existing Exchain wallet governs.
		message: 'a wallet that pays in a token must register with Exchain now, not reuse an Exchain wallet id',
		path: ['exchainWalletId'],
	});

export const guardedWalletRecordSchema = z.object({
	id: z.string(),
	hotWalletId: z.string(),
	ownerAddress: z.string(),
	quorumVkhs: z.array(z.string()),
	threshold: z.number(),
	stateTokenName: z.string(),
	scriptAddress: z.string().describe('The smart wallet address'),
	policyId: z.string().describe('Policy id of the state token'),
	exchainWalletId: z.string().nullable(),
	governedAsset: z.string().describe('The one asset agents pay in: lovelace or <policy>.<nameHex>'),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export const postGuardedWalletSchemaOutput = guardedWalletRecordSchema.extend({
	mandateEnglish: z
		.string()
		.nullable()
		.describe("Exchain's plain-English reading of the mandate, when it registered one"),
});

export const getGuardedWalletSchemaInput = z.object({
	hotWalletId: z.string().min(1).describe('The Purchasing hot wallet'),
});

export const guardedWalletAssetSchema = z.object({
	unit: z.string().describe('lovelace or <policy><nameHex>'),
	quantity: z.string().describe('Held by the smart wallet, in minor units'),
	limit: z.string().nullable().describe('On-chain limit per period; null when unlisted, so the asset is frozen'),
	spentInPeriod: z.string().nullable().describe('Spent in the period the datum last recorded; null when unlisted'),
});

export const guardedWalletChainStateSchema = z.object({
	lovelace: z.string().describe('Smart wallet balance, in lovelace'),
	periodLimitLovelace: z.string().describe('On-chain limit per period, in lovelace'),
	spentInPeriodLovelace: z.string().describe('Spent in the period the datum last recorded, in lovelace'),
	periodStart: z.date().describe('Start of that period'),
	periodLengthMs: z.string().describe('Period length, in milliseconds'),
	minBalanceLovelace: z.string().describe('Reserve the wallet never spends below, in lovelace'),
	assets: z
		.array(guardedWalletAssetSchema)
		.describe('Every asset the wallet holds or limits, the state token excluded'),
});

export const getGuardedWalletSchemaOutput = z.object({
	guardedWallet: guardedWalletRecordSchema.nullable().describe('Null when the hot wallet is not guarded'),
	chain: guardedWalletChainStateSchema.nullable().describe('Null when not guarded or the chain read failed'),
	chainError: z.string().nullable().describe('Why the chain read failed'),
});

export const deleteGuardedWalletSchemaInput = z.object({
	hotWalletId: z.string().min(1).describe('The Purchasing hot wallet to detach'),
});

export const deleteGuardedWalletSchemaOutput = guardedWalletRecordSchema;
