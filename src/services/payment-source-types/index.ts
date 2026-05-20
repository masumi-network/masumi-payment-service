// Per-Payment-Source-Type service facade. Each Type lives in its own workspace package
// under packages/payment-source-v{1,2}/src/services/. This barrel re-exports the two
// packages' service modules side-by-side for code that wants to dispatch dynamically.
// New Types add a sibling package and extend this barrel; routes resolve the configured
// PaymentSource and dispatch to the matching Type module by name.
import { PaymentSourceType } from '@/generated/prisma/client';

import * as web3CardanoV1 from '@masumi/payment-source-v1/services';
import * as web3CardanoV2 from '@masumi/payment-source-v2/services';

export { web3CardanoV1, web3CardanoV2 };

export type PaymentSourceTypeModule = typeof web3CardanoV1 | typeof web3CardanoV2;

export function getPaymentSourceTypeModule(paymentSourceType: PaymentSourceType): PaymentSourceTypeModule {
	switch (paymentSourceType) {
		case PaymentSourceType.Web3CardanoV1:
			return web3CardanoV1;
		case PaymentSourceType.Web3CardanoV2:
			return web3CardanoV2;
	}
}
