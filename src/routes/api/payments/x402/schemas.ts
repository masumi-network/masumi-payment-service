import { z } from '@masumi/payment-core/zod';
import { Network } from '@/generated/prisma/client';

export const buildX402TxSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network'),
	blockchainIdentifier: z.string().min(1).max(8000).describe('The blockchainIdentifier from the PaymentRequest'),
	buyerAddress: z
		.string()
		.min(58)
		.max(120)
		.regex(/^(addr1|addr_test1)[0-9a-z]+$/, 'buyerAddress must be a bech32 Cardano address')
		.describe("The buyer's bech32 Cardano wallet address. UTxOs fetched from this address to build the unsigned tx."),
});

export const buildX402TxSchemaOutput = z.object({
	unsignedTxCbor: z.string().describe('Hex-encoded unsigned transaction CBOR. Sign with buyer wallet and submit.'),
	collateralReturnLovelace: z
		.string()
		.describe('Extra lovelace included for min-UTXO. Buyer receives this back as change after result submission.'),
});
