import { PaymentSourceType } from '@/generated/prisma/client';

export type PaymentSourceAdapter = {
	paymentSourceType: PaymentSourceType;
	label: string;
};

export { PaymentSourceType };
export {
	SupportedPaymentSourceChain,
	isCardanoAddressForNetwork,
	parseSupportedPaymentSourcesFromMetadata,
	paymentSourceTypeSchema,
	supportedPaymentSourceMetadataSchema,
	supportedPaymentSourceSchema,
	supportedPaymentSourcesSchema,
	validateSupportedPaymentSourcesOrThrow,
	type SupportedPaymentSource,
} from './payment-source';
export { SmartContractState, smartContractStateEqualsOnChainState } from './smart-contract-state';
export {
	decodeBlockchainIdentifier,
	generateBlockchainIdentifier,
	type DecodedBlockchainIdentifier,
} from './blockchain-identifier';
export { validateHexString } from './hex';
export { convertNetwork, convertNetworkToId } from './network';
