import type { PaymentSourceAdapter } from '@masumi/payment-core';
import { PaymentSourceType } from '@masumi/payment-core';

export const paymentSourceV1Adapter: PaymentSourceAdapter = {
	paymentSourceType: PaymentSourceType.Web3CardanoV1,
	label: 'Cardano payment escrow V1',
};

export {
	getDatumFromBlockchainIdentifier,
	getPaymentScriptFromPaymentSourceV1,
	getPaymentScriptV1,
	getRegistryScriptFromNetworkHandlerV1,
	getRegistryScriptV1,
} from './contract-generator';
