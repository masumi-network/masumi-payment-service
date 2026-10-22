import { Prisma } from '@/generated/prisma/client';

/** Prisma shapes the submit-result passes load per payment source and request. */
export type PaymentSourceWithRelations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentRequests: {
			include: {
				NextAction: true;
				CurrentTransaction: true;
				RequestedFunds: true;
				BuyerWallet: true;
				SmartContractWallet: {
					include: {
						Secret: true;
					};
				};
			};
		};
		AdminWallets: true;
		FeeReceiverNetworkWallet: true;
		PaymentSourceConfig: true;
	};
}>;

export type PaymentRequestWithRelations = PaymentSourceWithRelations['PaymentRequests'][number];
