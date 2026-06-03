import type { PaymentSource } from '@/generated/prisma/client';
import { PaymentSourceType } from '@/generated/prisma/client';
import { getRegistryScriptFromNetworkHandlerV1 } from '@masumi/payment-source-v1';
import { getRegistryScriptFromNetworkHandlerV2 } from '@masumi/payment-source-v2';
import { assertNever } from '@/utils/assert-never';

export { SmartContractState, smartContractStateEqualsOnChainState } from '@masumi/payment-core';
export {
	getPaymentScriptV1,
	getRegistryScriptFromNetworkHandlerV1,
	getRegistryScriptV1,
} from '@masumi/payment-source-v1';
export {
	getPaymentScriptV2,
	getRegistryScriptFromNetworkHandlerV2,
	getRegistryScriptV2,
} from '@masumi/payment-source-v2';

export async function getRegistryScriptFromNetworkHandler(paymentSource: PaymentSource) {
	switch (paymentSource.paymentSourceType) {
		case PaymentSourceType.Web3CardanoV1:
			return getRegistryScriptFromNetworkHandlerV1(paymentSource);
		case PaymentSourceType.Web3CardanoV2:
			return getRegistryScriptFromNetworkHandlerV2(paymentSource);
		default:
			return assertNever(paymentSource.paymentSourceType);
	}
}
