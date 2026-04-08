import { z } from '@/utils/zod-openapi';
import { Network } from '@/generated/prisma/client';

export const buildX402TxSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network'),
	blockchainIdentifier: z.string().min(1).describe('The blockchainIdentifier from the PaymentRequest'),
	buyerAddress: z
		.string()
		.min(40)
		.max(200)
		.describe("The buyer's bech32 Cardano wallet address. UTxOs fetched from this address to build the unsigned tx."),
});

export const buildX402TxSchemaOutput = z.object({
	unsignedTxCbor: z.string().describe('Hex-encoded unsigned transaction CBOR. Sign with buyer wallet and submit.'),
	collateralReturnLovelace: z
		.string()
		.describe('Extra lovelace included for min-UTXO. Buyer receives this back as change after result submission.'),
});
