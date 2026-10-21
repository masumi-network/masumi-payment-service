import { Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';

/**
 * When the dashboard marks a payment/purchase init as a developer test,
 * block Mainnet while leaving normal inits (flag omitted) unchanged.
 */
export function assertDeveloperTestPaymentAllowed(params: { network: Network; developerTestIntent?: boolean }): void {
	if (params.developerTestIntent !== true) {
		return;
	}
	if (params.network === Network.Mainnet) {
		throw createHttpError(
			403,
			'Developer test payments are not allowed on Mainnet. Use Preprod or omit developerTestIntent for production payments.',
		);
	}
}
