import { adminAuthenticatedEndpointFactory, AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { HotWalletType, Network, WalletType } from '@/generated/prisma/client';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';

const walletBaseOptionSchema = z.object({
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

const listWalletBaseSchemaInput = z.object({
	network: z.nativeEnum(Network).optional().describe('Filter wallet bases by Cardano network'),
	paymentSourceId: z.string().optional().describe('Filter wallet bases by payment source'),
	walletVkey: z.string().optional().describe('Filter wallet bases by payment key hash'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(100).describe('Number of results'),
});

const listWalletBaseSchemaOutput = z.object({
	wallets: z.array(walletBaseOptionSchema),
});

const ensureWalletBaseSchemaInput = z.object({
	hotWalletId: z.string().min(1).describe('HotWallet to expose as a public WalletBase option'),
});

const ensureWalletBaseSchemaOutput = walletBaseOptionSchema;

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
