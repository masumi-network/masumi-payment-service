import { Network, PaymentSourceType } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';

export const paymentSourceSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(10).describe('The number of payment sources to return'),
	cursorId: z.string().max(250).optional().describe('Used to paginate through the payment sources'),
});

export const adminWalletSchema = z
	.object({
		walletAddress: z.string().describe('Cardano address of the admin wallet'),
		order: z.number().describe('Order/index of this admin wallet '),
	})
	.openapi('AdminWallet');

export const paymentSourceOutputSchema = z
	.object({
		id: z.string().describe('Unique identifier for the payment source'),
		createdAt: z.date().describe('Timestamp when the payment source was created'),
		updatedAt: z.date().describe('Timestamp when the payment source was last updated'),
		network: z.nativeEnum(Network).describe('The Cardano network (Mainnet, Preprod, or Preview)'),
		paymentSourceType: z.nativeEnum(PaymentSourceType).describe('Payment source type for adapter dispatch'),
		requiredAdminSignatures: z
			.number()
			.int()
			.nullable()
			.describe('Required weighted admin signatures for Web3CardanoV2 sources. Null for Web3CardanoV1.'),
		policyId: z.string().nullable().describe('Policy ID for the agent registry NFTs. Null if not applicable'),
		smartContractAddress: z.string().describe('Address of the smart contract for this payment source'),
		lastIdentifierChecked: z
			.string()
			.nullable()
			.describe('Last agent identifier checked during registry sync. Null if not synced yet'),
		lastCheckedAt: z.date().nullable().describe('Timestamp when the registry was last synced. Null if never synced'),
		AdminWallets: z.array(adminWalletSchema).describe('List of admin wallets for dispute resolution'),
		FeeReceiverNetworkWallet: z
			.object({
				walletAddress: z.string().describe('Cardano address that receives network fees'),
			})
			.nullable()
			.describe('Wallet that receives network fees from transactions'),
		feeRatePermille: z.number().min(0).max(1000).describe('Fee rate in permille'),
	})
	.openapi('PaymentSource');

export const paymentSourceSchemaOutput = z.object({
	PaymentSources: z.array(paymentSourceOutputSchema).describe('List of payment sources'),
});
