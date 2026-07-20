import { Network, PaymentSourceType } from '@/generated/prisma/client';
import { DEFAULTS } from '@masumi/payment-core/config';
import {
	SupportedPaymentSourceChain,
	type SupportedPaymentSource,
	type SupportedPaymentSourcePricing,
} from '@/types/payment-source';
import { getPaymentScriptV2 } from '@masumi/payment-source-v2';

function getDefaultV2AdminWallets(network: Network) {
	return network === Network.Mainnet
		? [DEFAULTS.ADMIN_WALLET1_MAINNET, DEFAULTS.ADMIN_WALLET2_MAINNET, DEFAULTS.ADMIN_WALLET3_MAINNET]
		: [DEFAULTS.ADMIN_WALLET1_PREPROD, DEFAULTS.ADMIN_WALLET2_PREPROD, DEFAULTS.ADMIN_WALLET3_PREPROD];
}

export async function getDefaultSupportedPaymentSources(
	network: Network,
	pricing: SupportedPaymentSourcePricing,
): Promise<SupportedPaymentSource[]> {
	const { smartContractAddress } = await getPaymentScriptV2(
		getDefaultV2AdminWallets(network),
		DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
		network === Network.Mainnet ? DEFAULTS.COOLDOWN_TIME_MAINNET : DEFAULTS.COOLDOWN_TIME_PREPROD,
		network,
	);

	return [
		{
			chain: SupportedPaymentSourceChain.Cardano,
			network,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			address: smartContractAddress,
			pricing,
		},
	];
}
