import { z } from '@/utils/zod-openapi';
import { createPurchaseInitSchemaInput, createPurchaseInitSchemaOutput } from '../schemas';

export const createX402PurchaseSchemaInput = createPurchaseInitSchemaInput.extend({
	buyerAddress: z
		.string()
		.min(40)
		.max(200)
		.describe(
			"The buyer's external Cardano wallet address (bech32). UTXOs will be fetched from this address to build the unsigned transaction.",
		),
});

export const createX402PurchaseSchemaOutput = createPurchaseInitSchemaOutput.extend({
	unsignedTxCbor: z
		.string()
		.describe('Hex-encoded unsigned transaction CBOR. Sign with your Cardano wallet and submit to the network.'),
});
