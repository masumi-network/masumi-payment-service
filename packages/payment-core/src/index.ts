import { PaymentSourceType } from '@prisma/client';

export type PaymentSourceAdapter = {
	paymentSourceType: PaymentSourceType;
	label: string;
};

export { PaymentSourceType };
export {
	MAX_SUPPORTED_PAYMENT_SOURCES,
	SupportedPaymentSourceChain,
	isCardanoAddressForNetwork,
	isCardanoPubKeyAddressForNetwork,
	parseSupportedPaymentSourcesFromMetadata,
	paymentSourceTypeSchema,
	supportedPaymentSourceMetadataSchema,
	supportedPaymentSourceSchema,
	supportedPaymentSourcesSchema,
	validateSupportedPaymentSourcesOrThrow,
	type RegistryMetadataPaymentSource,
	type SupportedPaymentSource,
} from './payment-source';
export { SmartContractState, smartContractStateEqualsOnChainState } from './smart-contract-state';
export {
	VerificationMethod,
	parseVerificationsFromMetadata,
	verificationMetadataSchema,
	verificationRowToApi,
	verificationSchema,
	verificationToRow,
	verificationsSchema,
	verificationsToMetadata,
	type AgentVerificationRow,
	type Verification,
} from './verification';
export {
	decodeBlockchainIdentifier,
	generateBlockchainIdentifier,
	type DecodedBlockchainIdentifier,
} from './blockchain-identifier';
export { validateHexString } from './hex';
export {
	BASE_MAINNET_CAIP2,
	BASE_SEPOLIA_CAIP2,
	CARDANO_MAINNET_CAIP2,
	CARDANO_PREPROD_CAIP2,
	DEFAULT_ADMIN_CAIP2_NETWORK_LIMIT,
	caip2LimitToCardanoNetworks,
	caip2ToCardanoNetwork,
	cardanoNetworkToCaip2,
	cardanoNetworksToCaip2,
	convertNetwork,
	convertNetworkToId,
	isAllowedCaip2Network,
	mergeCaip2NetworkLimits,
} from './network';
