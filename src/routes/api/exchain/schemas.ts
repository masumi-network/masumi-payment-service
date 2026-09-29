import { z } from '@masumi/payment-core/zod';

export const exchainReadTokenSchemaInput = z.object({
	hotWalletId: z
		.string()
		.min(1)
		.optional()
		.describe("A guarded hot wallet; its registered Exchain wallet is shown. Omit to use the node's EXCHAIN_WALLET_ID"),
});

export const exchainReadTokenSchemaOutput = z.object({
	walletId: z.string().describe('Exchain id of the guarded wallet the embedded page shows'),
	url: z.string().describe('The embedded page URL for that wallet, read token included'),
	token: z
		.string()
		.describe('Read-only, wallet-scoped Exchain token. Handed to the embedded page when it asks for a refresh'),
	expiresAt: z.string().describe('When the token stops working (Exchain issues 15-minute tokens)'),
});
