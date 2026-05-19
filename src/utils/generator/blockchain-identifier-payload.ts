import { PaymentSourceType } from '@/generated/prisma/client';

export type SignedBlockchainIdentifierPayloadInput = {
	inputHash: string;
	agentIdentifier: string;
	purchaserIdentifier: string;
	sellerIdentifier: string;
	requestedFunds: Array<{ amount: string; unit: string }> | null;
	payByTime: string;
	submitResultTime: string;
	unlockTime: string;
	externalDisputeUnlockTime: string;
	sellerAddress: string;
	sellerReturnAddress?: string | null;
	paymentSourceType: PaymentSourceType;
};

export function buildSignedBlockchainIdentifierPayload(input: SignedBlockchainIdentifierPayloadInput) {
	return {
		inputHash: input.inputHash,
		agentIdentifier: input.agentIdentifier,
		purchaserIdentifier: input.purchaserIdentifier,
		sellerIdentifier: input.sellerIdentifier,
		RequestedFunds: input.requestedFunds,
		payByTime: input.payByTime,
		submitResultTime: input.submitResultTime,
		unlockTime: input.unlockTime,
		externalDisputeUnlockTime: input.externalDisputeUnlockTime,
		sellerAddress: input.sellerAddress,
		...(input.paymentSourceType === PaymentSourceType.Web3CardanoV2
			? { sellerReturnAddress: input.sellerReturnAddress ?? null }
			: {}),
	};
}
