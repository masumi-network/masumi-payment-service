import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';

// Registration-time guard: every x402 network a registry entry advertises must
// be enabled and have a configured facilitator (owned wallet or remote URL),
// otherwise the advertised payment option could never settle.
//
// Throws createHttpError(400) for unavailable networks; a failing Prisma query
// propagates unchanged so infrastructure faults surface as 500s. Callers must
// NOT blanket-wrap this in a catch-all 400 — that turned DB outages into
// client faults and leaked internal error messages.
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
		throw createHttpError(400, `x402 network is not available for settlement: ${unavailableNetworks.join(', ')}`);
	}
}
