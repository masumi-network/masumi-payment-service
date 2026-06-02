import { Network, HotWalletType, PaymentSourceType } from '@/generated/prisma/enums';
import { ApiClient, PaymentSourceResponse } from './apiClient';
import '../setup/globals';

/**
 * Helper functions for querying PaymentSource data in E2E tests
 *
 * Uses the API client to query payment sources instead of direct database access.
 */

function resolvePaymentSourceType(paymentSourceType?: PaymentSourceType): PaymentSourceType {
	return paymentSourceType ?? global.testConfig?.paymentSourceType ?? PaymentSourceType.Web3CardanoV1;
}

function walletKeySet(paymentSource: PaymentSourceResponse): Set<string> {
	return new Set([
		...paymentSource.SellingWallets.map((wallet) => wallet.walletVkey),
		...paymentSource.PurchasingWallets.map((wallet) => wallet.walletVkey),
	]);
}

export async function getE2EPaymentSource(
	network: Network,
	paymentSourceType?: PaymentSourceType,
	apiClient?: ApiClient,
): Promise<PaymentSourceResponse> {
	const client = apiClient || global.testApiClient;
	const resolvedPaymentSourceType = resolvePaymentSourceType(paymentSourceType);

	if (!client) {
		throw new Error('ApiClient not provided and global.testApiClient is not available');
	}

	const response = await client.queryPaymentSources({ take: 100 });

	const paymentSource = response.ExtendedPaymentSources.find(
		(ps) => ps.network === network && ps.paymentSourceType === resolvedPaymentSourceType,
	);

	if (!paymentSource) {
		throw new Error(
			`No active ${resolvedPaymentSourceType} PaymentSource found for network ${network}. Please run database seeding first.`,
		);
	}

	return paymentSource;
}

/**
 * Get the active smart contract address for a given network and payment source type
 */
export async function getActiveSmartContractAddress(
	network: Network,
	paymentSourceType?: PaymentSourceType,
	apiClient?: ApiClient,
): Promise<string> {
	const paymentSource = await getE2EPaymentSource(network, paymentSourceType, apiClient);

	return paymentSource.smartContractAddress;
}

/**
 * Get an active wallet VKey for testing by wallet type and network
 */
export async function getActiveWalletVKey(
	network: Network,
	walletType: HotWalletType = HotWalletType.Selling,
	paymentSourceType?: PaymentSourceType,
	apiClient?: ApiClient,
): Promise<string> {
	const resolvedPaymentSourceType = resolvePaymentSourceType(paymentSourceType);
	const paymentSource = await getE2EPaymentSource(network, resolvedPaymentSourceType, apiClient);

	// Get wallets based on type
	const wallets = walletType === HotWalletType.Selling ? paymentSource.SellingWallets : paymentSource.PurchasingWallets;

	if (wallets.length === 0) {
		throw new Error(
			`No active ${walletType} wallet found for ${resolvedPaymentSourceType} on ${network}. Please run database seeding first.`,
		);
	}

	// Get the first wallet (payment sources are returned in descending order by createdAt)
	const wallet = wallets[0];

	console.log(
		`✅ Found active ${walletType} wallet for ${resolvedPaymentSourceType} on ${network}: ${wallet.walletVkey}`,
	);

	return wallet.walletVkey;
}

export async function validateE2EPaymentSourceWallets(
	network: Network,
	paymentSourceType?: PaymentSourceType,
	apiClient?: ApiClient,
): Promise<{ valid: boolean; errors: string[] }> {
	const errors: string[] = [];
	const resolvedPaymentSourceType = resolvePaymentSourceType(paymentSourceType);
	const paymentSource = await getE2EPaymentSource(network, resolvedPaymentSourceType, apiClient);

	if (paymentSource.SellingWallets.length === 0) {
		errors.push(`No selling wallets configured for ${resolvedPaymentSourceType} on ${network}`);
	}
	if (paymentSource.PurchasingWallets.length === 0) {
		errors.push(`No purchasing wallets configured for ${resolvedPaymentSourceType} on ${network}`);
	}

	if (resolvedPaymentSourceType === PaymentSourceType.Web3CardanoV2) {
		const client = apiClient || global.testApiClient;
		const response = await client.queryPaymentSources({ take: 100 });
		const v1PaymentSource = response.ExtendedPaymentSources.find(
			(ps) => ps.network === network && ps.paymentSourceType === PaymentSourceType.Web3CardanoV1,
		);

		if (v1PaymentSource != null) {
			const v1Wallets = walletKeySet(v1PaymentSource);
			const overlappingVkeys = [...walletKeySet(paymentSource)].filter((walletVkey) => v1Wallets.has(walletVkey));

			if (overlappingVkeys.length > 0) {
				errors.push(
					`V2 E2E wallets must be separate from V1 wallets. Overlapping wallet vkeys: ${overlappingVkeys.join(', ')}`,
				);
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Get test wallet configuration dynamically from API
 */
export async function getTestWalletFromDatabase(
	network: Network,
	role: 'seller' | 'buyer',
	apiClient?: ApiClient,
	paymentSourceType?: PaymentSourceType,
): Promise<{
	name: string;
	vkey: string;
	description: string;
}> {
	const walletType = role === 'seller' ? HotWalletType.Selling : HotWalletType.Purchasing;

	try {
		const resolvedPaymentSourceType = resolvePaymentSourceType(paymentSourceType);
		const vkey = await getActiveWalletVKey(network, walletType, resolvedPaymentSourceType, apiClient);

		return {
			name: `Dynamic ${role} wallet (${resolvedPaymentSourceType}, ${network})`,
			vkey: vkey,
			description: `Dynamically retrieved ${role} wallet for ${resolvedPaymentSourceType} ${network} e2e tests`,
		};
	} catch (error) {
		throw new Error(`Failed to get ${role} wallet for ${network}: ${error}`);
	}
}

export default {
	getE2EPaymentSource,
	getActiveSmartContractAddress,
	getActiveWalletVKey,
	validateE2EPaymentSourceWallets,
	getTestWalletFromDatabase,
};
