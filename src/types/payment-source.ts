import { prisma } from '@masumi/payment-core/db';

export {
	MAX_SUPPORTED_PAYMENT_SOURCES,
	POSTGRES_BIGINT_MAX,
	SupportedPaymentSourceChain,
	isCardanoAddressForNetwork,
	isCardanoPubKeyAddressForNetwork,
	parseSupportedPaymentSourcesFromMetadata,
	supportedPaymentSourceInputSchema,
	supportedPaymentSourceSchema,
	supportedPaymentSourceMetadataSchema,
	supportedPaymentSourcesInputSchema,
	supportedPaymentSourcesSchema,
	validateSupportedPaymentSourcesOrThrow,
	type RegistryMetadataPaymentSource,
	type SupportedPaymentSource,
} from '@masumi/payment-core/payment-source';

export async function validateX402NetworksAvailableOrThrow(
	supportedPaymentSources: Array<{ chain: string; network: string }>,
): Promise<void> {
	const requestedNetworks = [
		...new Set(supportedPaymentSources.filter((source) => source.chain === 'EVM').map((source) => source.network)),
	];
	if (requestedNetworks.length === 0) return;

	const availableNetworks = await prisma.x402Network.findMany({
		where: {
			caip2Id: { in: requestedNetworks },
			isEnabled: true,
			OR: [{ facilitatorWalletId: { not: null } }, { facilitatorUrl: { not: null } }],
		},
		select: { caip2Id: true },
	});
	const availableIds = new Set(availableNetworks.map((network) => network.caip2Id));
	const unavailableNetworks = requestedNetworks.filter((network) => !availableIds.has(network));
	if (unavailableNetworks.length > 0) {
		throw new Error(`x402 network is not available for settlement: ${unavailableNetworks.join(', ')}`);
	}
}
