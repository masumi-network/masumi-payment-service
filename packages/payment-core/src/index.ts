import { PaymentSourceType } from '@/generated/prisma/client';

export type PaymentSourceAdapter = {
	paymentSourceType: PaymentSourceType;
	label: string;
};

export type PaymentSourceAdapterRegistry = {
	register(adapter: PaymentSourceAdapter): void;
	get(paymentSourceType: PaymentSourceType): PaymentSourceAdapter;
	list(): PaymentSourceAdapter[];
};

export function createPaymentSourceAdapterRegistry(): PaymentSourceAdapterRegistry {
	const adapters = new Map<PaymentSourceType, PaymentSourceAdapter>();

	return {
		register(adapter) {
			adapters.set(adapter.paymentSourceType, adapter);
		},
		get(paymentSourceType) {
			const adapter = adapters.get(paymentSourceType);
			if (adapter == null) {
				throw new Error(`No payment source adapter registered for ${paymentSourceType}`);
			}
			return adapter;
		},
		list() {
			return [...adapters.values()];
		},
	};
}

export { PaymentSourceType };
export {
	SupportedPaymentSourceChain,
	parseSupportedPaymentSources,
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
