import { z } from '@masumi/payment-core/zod';

export const exchainReadTokenSchemaInput = z.object({});

export const exchainReadTokenSchemaOutput = z.object({
	walletId: z.string().describe('Exchain id of the guarded wallet the embedded page shows'),
	url: z.string().describe('The embedded page URL for that wallet, read token included'),
	token: z
		.string()
		.describe('Read-only, wallet-scoped Exchain token. Handed to the embedded page when it asks for a refresh'),
	expiresAt: z.string().describe('When the token stops working (Exchain issues 15-minute tokens)'),
});
