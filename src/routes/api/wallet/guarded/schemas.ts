import { z } from '@masumi/payment-core/zod';

const MAX_QUORUM_SIZE = 16;
const keyHash = z
	.string()
	.regex(/^[0-9a-f]{56}$/, '28-byte hex key hash')
	.describe('Quorum member key hash (28-byte hex)');
const lovelace = z.string().regex(/^\d+$/, 'a lovelace integer').describe('Amount in lovelace');
const exchainWalletId = z
	.string()
	.regex(/^wal_[0-9A-HJKMNP-TV-Z]{26}$/, 'wal_ followed by 26 ULID characters')
	.describe('Exchain wallet id (wal_...)');

export const guardedWalletMandateSchema = z
	.object({
		perTxCap: lovelace.describe('Largest single lock Exchain co-signs, in lovelace'),
		daily: lovelace.describe("Daily limit, in lovelace. Must equal the wallet's on-chain period limit"),
		perSeller: lovelace.describe('Daily limit per seller, in lovelace'),
		perAgent: lovelace.describe('Daily limit per agent, in lovelace'),
		envelope: lovelace.describe('Lifetime limit, in lovelace'),
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

export const guardedWalletChainStateSchema = z.object({
	lovelace: z.string().describe('Smart wallet balance, in lovelace'),
	periodLimitLovelace: z.string().describe('On-chain limit per period, in lovelace'),
	spentInPeriodLovelace: z.string().describe('Spent in the period the datum last recorded, in lovelace'),
	periodStart: z.date().describe('Start of that period'),
	periodLengthMs: z.string().describe('Period length, in milliseconds'),
	minBalanceLovelace: z.string().describe('Reserve the wallet never spends below, in lovelace'),
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
