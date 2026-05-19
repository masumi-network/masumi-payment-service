import type { PaymentSourceAdapter } from '@masumi/payment-core';
import { PaymentSourceType } from '@masumi/payment-core';

export const paymentSourceV2Adapter: PaymentSourceAdapter = {
	paymentSourceType: PaymentSourceType.Web3CardanoV2,
	label: 'Cardano payment escrow V2',
};

export {
	getDatumV2,
	getPaymentScriptFromPaymentSourceV2,
	getPaymentScriptV2,
	getRegistryScriptFromNetworkHandlerV2,
	getRegistryScriptV2,
} from './contract-generator';
