import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import { guardedWalletAssetSchema } from '../schemas';

const hotWalletId = z.string().min(1).describe('The guarded Purchasing hot wallet');
const cborHex = z
	.string()
	.min(2)
	.max(64 * 1024 * 2)
	.regex(/^(?:[0-9a-fA-F]{2})+$/, 'even-length hex')
	.describe('Transaction CBOR (hex)');

export const guardedHydraTransferSchema = z.object({
	id: z.string(),
	direction: z.nativeEnum(GuardedHydraTransferDirection),
	status: z.nativeEnum(GuardedHydraTransferStatus),
	hydraHeadId: z.string(),
	txHash: z.string().describe('The deposit L1 transaction id, or the in-head decommit transaction id'),
	walletUtxoRef: z.string().describe('The wallet UTxO this transfer moves (txHash#index)'),
	signBefore: z.date().nullable().describe('The owner must sign and submit before this moment'),
	recoverableAt: z.date().nullable().describe('Deposit only: after this an unabsorbed deposit can be recovered to L1'),
	submittedAt: z.date().nullable(),
	confirmedAt: z.date().nullable(),
	failureReason: z.string().nullable(),
	createdAt: z.date(),
});

const preparedTransferSchema = z.object({
	transfer: guardedHydraTransferSchema,
	unsignedTx: cborHex.describe('Sign this with the owner key (partial sign) and send it back to the submit endpoint'),
});

export const getGuardedHydraSchemaInput = z.object({ hotWalletId });

export const getGuardedHydraSchemaOutput = z.object({
	location: z
		.enum(['L1', 'L2', 'Unknown'])
		.describe('L2: inside a connected head. L1: on chain. Unknown: neither could be read, e.g. while it moves'),
	hydraHeadId: z.string().nullable(),
	walletUtxoRef: z.string().nullable().describe('The wallet UTxO inside the head (txHash#index)'),
	state: z
		.object({
			lovelace: z.string(),
			periodLimitLovelace: z.string(),
			spentInPeriodLovelace: z.string(),
			periodStart: z.date(),
			periodLengthMs: z.string(),
			minBalanceLovelace: z.string(),
			assets: z.array(guardedWalletAssetSchema),
		})
		.nullable()
		.describe('The wallet datum and balance where the wallet is now'),
	l1Error: z.string().nullable(),
	transfers: z.array(guardedHydraTransferSchema).describe('The most recent moves, newest first'),
});

export const postGuardedHydraDepositSchemaInput = z.object({
	hotWalletId,
	hydraHeadId: z.string().min(1).describe('The open head the hot wallet takes part in'),
});
export const postGuardedHydraDepositSchemaOutput = preparedTransferSchema;

export const postGuardedHydraWithdrawSchemaInput = z.object({ hotWalletId });
export const postGuardedHydraWithdrawSchemaOutput = preparedTransferSchema;

export const postGuardedHydraSubmitSchemaInput = z.object({
	transferId: z.string().min(1).describe('The Prepared transfer'),
	signedTx: cborHex.describe('The prepared transaction with the owner witness added'),
});
export const postGuardedHydraSubmitSchemaOutput = z.object({ transfer: guardedHydraTransferSchema });

export const postGuardedHydraRecoverSchemaInput = z.object({
	transferId: z.string().min(1).describe('The Submitted deposit the head never took in'),
});
export const postGuardedHydraRecoverSchemaOutput = z.object({
	transfer: guardedHydraTransferSchema,
	reason: z
		.string()
		.nullable()
		.describe('Null when the node confirmed the request; otherwise why the outcome is not known yet'),
});
