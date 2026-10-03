import { adminAuthenticatedEndpointFactory, AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { HotWalletType, Network, WalletType } from '@/generated/prisma/client';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';

export const walletBaseOptionSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	paymentSourceId: z.string(),
	type: z.nativeEnum(WalletType),
	walletVkey: z.string(),
	walletAddress: z.string(),
	note: z.string().nullable(),
	PaymentSource: z.object({
		id: z.string(),
		network: z.nativeEnum(Network),
		paymentSourceType: z.string(),
	}),
});

export const listWalletBaseSchemaInput = z.object({
	network: z.nativeEnum(Network).optional().describe('Filter wallet bases by Cardano network'),
	paymentSourceId: z.string().optional().describe('Filter wallet bases by payment source'),
	walletVkey: z.string().optional().describe('Filter wallet bases by payment key hash'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(100).describe('Number of results'),
});

export const listWalletBaseSchemaOutput = z.object({
	wallets: z.array(walletBaseOptionSchema),
});

/**
 * Two ways to name a wallet the Hydra surface can point a relation at.
 *
 * `hotWalletId` mirrors one of our own wallets, which is only useful for
 * testing against ourselves. A counterparty at another organisation is reached
 * the other way: they send us their address out of band, and we record it. That
 * is the case the cross-organisation handshake actually needs, since a relation
 * is defined by whose wallet sits on each side.
 */
export const ensureWalletBaseSchemaInput = z.union([
	z.object({
		hotWalletId: z.string().min(1).describe('HotWallet to expose as a public WalletBase option'),
	}),
	z.object({
		paymentSourceId: z.string().min(1).describe('Payment source this counterparty belongs to'),
		walletAddress: z.string().min(1).max(250).describe("The counterparty's Cardano address, as they gave it to you"),
		type: z.nativeEnum(WalletType).optional().describe('Their role in the trade. Defaults to Seller.'),
		note: z.string().max(250).optional().describe('Label, so the picker shows more than a bare type'),
	}),
]);

export const ensureWalletBaseSchemaOutput = walletBaseOptionSchema;

export const listHydraWalletBasesGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listWalletBaseSchemaInput,
	output: listWalletBaseSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof listWalletBaseSchemaInput>; ctx: AuthContext }) => {
		const allowedNetworks = input.network
			? ctx.networkLimit.filter((network) => network === input.network)
			: ctx.networkLimit;

		const wallets = await prisma.walletBase.findMany({
			where: {
				...(input.paymentSourceId ? { paymentSourceId: input.paymentSourceId } : {}),
				...(input.walletVkey ? { walletVkey: input.walletVkey } : {}),
				PaymentSource: {
					network: { in: allowedNetworks },
				},
			},
			select: {
				id: true,
				createdAt: true,
				updatedAt: true,
				paymentSourceId: true,
				type: true,
				walletVkey: true,
				walletAddress: true,
				note: true,
				PaymentSource: {
					select: {
						id: true,
						network: true,
						paymentSourceType: true,
					},
				},
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			...(input.cursorId ? { skip: 1 } : {}),
		});

		return {
			wallets: wallets.map((wallet) => ({
				...wallet,
				createdAt: wallet.createdAt.toISOString(),
				updatedAt: wallet.updatedAt.toISOString(),
			})),
		};
	},
});

export const ensureHydraWalletBasePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: ensureWalletBaseSchemaInput,
	output: ensureWalletBaseSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof ensureWalletBaseSchemaInput>; ctx: AuthContext }) => {
		if ('walletAddress' in input) {
			return await recordCounterpartyWallet(input, ctx);
		}

		const hotWallet = await prisma.hotWallet.findFirst({
			where: {
				id: input.hotWalletId,
				deletedAt: null,
				PaymentSource: {
					network: { in: ctx.networkLimit },
				},
				...buildHotWalletScopeFilter(ctx.walletScopeIds),
			},
			select: {
				id: true,
				paymentSourceId: true,
				walletVkey: true,
				walletAddress: true,
				type: true,
				note: true,
			},
		});

		if (!hotWallet) {
			throw createHttpError(404, 'HotWallet not found');
		}

		const walletType = mapHotWalletTypeToWalletType(hotWallet.type);
		const wallet = await prisma.walletBase.upsert({
			where: {
				paymentSourceId_walletVkey_walletAddress_type: {
					paymentSourceId: hotWallet.paymentSourceId,
					walletVkey: hotWallet.walletVkey,
					walletAddress: hotWallet.walletAddress,
					type: walletType,
				},
			},
			create: {
				paymentSourceId: hotWallet.paymentSourceId,
				walletVkey: hotWallet.walletVkey,
				walletAddress: hotWallet.walletAddress,
				type: walletType,
				note: hotWallet.note,
			},
			update: {
				note: hotWallet.note,
			},
			select: {
				id: true,
				createdAt: true,
				updatedAt: true,
				paymentSourceId: true,
				type: true,
				walletVkey: true,
				walletAddress: true,
				note: true,
				PaymentSource: {
					select: {
						id: true,
						network: true,
						paymentSourceType: true,
					},
				},
			},
		});

		return {
			...wallet,
			createdAt: wallet.createdAt.toISOString(),
			updatedAt: wallet.updatedAt.toISOString(),
		};
	},
});

function mapHotWalletTypeToWalletType(type: HotWalletType): WalletType {
	return type === HotWalletType.Purchasing ? WalletType.Buyer : WalletType.Seller;
}

/**
 * Record a counterparty's wallet from the address they gave us.
 *
 * The vkey is derived rather than accepted, so a caller cannot record an
 * address under someone else's key hash — the hash is what the handshake
 * verifies an offer's signature against, and a mismatch there would let the
 * wrong party open a head with us.
 *
 * Idempotent on (source, vkey, address, type): the same counterparty recorded
 * twice is the same row, so re-pasting an address is harmless.
 */
async function recordCounterpartyWallet(
	input: { paymentSourceId: string; walletAddress: string; type?: WalletType; note?: string },
	ctx: AuthContext,
) {
	const source = await prisma.paymentSource.findFirst({
		where: { id: input.paymentSourceId, deletedAt: null, network: { in: ctx.networkLimit } },
		select: { id: true, network: true },
	});
	if (!source) {
		throw createHttpError(404, 'Payment source not found');
	}

	const address = input.walletAddress.trim();
	// Mainnet and testnet addresses carry different prefixes; recording one under
	// the other's payment source would produce a relation that can never settle.
	const isTestnetAddress = address.startsWith('addr_test');
	if (isTestnetAddress !== (source.network !== Network.Mainnet)) {
		throw createHttpError(400, `That address is not a ${source.network} address`);
	}

	let walletVkey: string;
	try {
		const { resolvePaymentKeyHash } = await import('@meshsdk/core');
		walletVkey = resolvePaymentKeyHash(address);
	} catch {
		throw createHttpError(400, 'That is not a valid Cardano address');
	}

	const type = input.type ?? WalletType.Seller;
	const wallet = await prisma.walletBase.upsert({
		where: {
			paymentSourceId_walletVkey_walletAddress_type: {
				paymentSourceId: source.id,
				walletVkey,
				walletAddress: address,
				type,
			},
		},
		create: {
			paymentSourceId: source.id,
			walletVkey,
			walletAddress: address,
			type,
			note: input.note ?? null,
		},
		update: { ...(input.note === undefined ? {} : { note: input.note }) },
		select: {
			id: true,
			createdAt: true,
			updatedAt: true,
			paymentSourceId: true,
			type: true,
			walletVkey: true,
			walletAddress: true,
			note: true,
			PaymentSource: { select: { id: true, network: true, paymentSourceType: true } },
		},
	});

	return {
		...wallet,
		createdAt: wallet.createdAt.toISOString(),
		updatedAt: wallet.updatedAt.toISOString(),
	};
}
