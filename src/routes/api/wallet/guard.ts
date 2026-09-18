import createHttpError from 'http-errors';
import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { convertNetwork } from '@/utils/converter/network-convert';
import {
	CosignTransportError,
	mintCosignReadToken,
	registerCosignWallet,
} from '@masumi/payment-source-v2/smart-wallet/cosign-client';
import {
	cosignConfigFor,
	DEFAULT_COSIGN_TOKEN_REF,
	guardedWalletScript,
} from '@masumi/payment-source-v2/services/purchases/batch-payments/guarded-funding';

const keyHash = z.string().regex(/^[0-9a-f]{56}$/, '28-byte hex key hash');
const amount = z.string().regex(/^[0-9]+$/, 'minor units as a decimal string');

export const guardedWalletSchema = z.object({
	walletId: z.string().describe('The purchasing wallet whose key is the agent key of the guarded wallet'),
	walletAddress: z.string().describe('Address of the guarded smart wallet'),
	stateToken: z.string().describe('`<policyId>.<assetName hex>` of the wallet state token'),
	scriptHash: z.string().describe('Hash of the parameterised wallet validator'),
	ownerKeyHash: z.string(),
	quorumKeyHashes: z.array(z.string()),
	quorumThreshold: z.number().int(),
	cosignBaseUrl: z.string(),
	cosignTokenRef: z
		.string()
		.describe('Name of the environment variable holding the node token. The token is never stored or returned'),
	exchainWalletId: z.string().describe('The wallet id the co-sign service issued at registration'),
	nodeId: z.string(),
	orgId: z.string(),
	registeredAt: z.date(),
});

export const postWalletGuardSchemaInput = z.object({
	walletId: z.string().min(1).max(250).describe('The purchasing wallet to turn into a guarded wallet'),
	walletAddress: z.string().min(1).max(250).describe('Address the guarded wallet was minted at'),
	stateToken: z
		.string()
		.regex(/^[0-9a-f]{56}\.([0-9a-f]{2}){1,32}$/)
		.describe('`<policyId>.<assetName hex>` of the wallet state token'),
	ownerKeyHash: keyHash.describe('Key hash of the owner (cold) key the wallet was minted with'),
	agentKeyHash: keyHash.describe('Agent key hash in the wallet datum; must be the key of `walletId`'),
	quorumKeyHashes: z.array(keyHash).min(1).max(16).describe('Quorum key hashes the wallet was minted with, in order'),
	quorumThreshold: z.number().int().min(1).describe('Quorum threshold the wallet was minted with'),
	cosignBaseUrl: z.string().url().max(500).describe('Base URL of the Exchain co-sign service'),
	cosignTokenRef: z
		.string()
		.regex(/^EXCHAIN_COSIGN_API_KEY[A-Z0-9_]*$/)
		.default(DEFAULT_COSIGN_TOKEN_REF)
		.describe('Name of the environment variable that holds the node token for this service'),
	nodeId: z.string().min(1).max(250).describe('Node identity the token is scoped to'),
	orgId: z.string().min(1).max(250).describe('Organisation the wallet belongs to'),
	governedAsset: z
		.string()
		.regex(/^(lovelace|[0-9a-f]{56}\.([0-9a-f]{2}){0,32})$/)
		.default('lovelace')
		.describe('The asset the mandate counts, `lovelace` or `<policyId>.<assetName hex>` (6 decimals)'),
	template: z.enum(['sokosumi-coworker', 'enterprise-pilot', 'x402-micro']).describe('Mandate template'),
	params: z
		.object({
			perTxCap: amount,
			daily: amount,
			perSeller: amount,
			perAgent: amount,
			envelope: amount,
			burstPerMinute: z.number().int().min(1),
		})
		.describe('Template parameters, in minor units of the governed asset'),
	registryGate: z.boolean().default(true).describe('Only pay sellers with a confirmed registry entry'),
});

export const postWalletGuardSchemaOutput = guardedWalletSchema.extend({
	mandateEnglish: z.string().describe('The mandate the co-sign service compiled, in plain English'),
});

export const deleteWalletGuardSchemaInput = z.object({
	walletId: z.string().min(1).max(250).describe('The purchasing wallet to return to unguarded funding'),
});

export const deleteWalletGuardSchemaOutput = guardedWalletSchema;

export const postWalletGuardReadTokenSchemaInput = z.object({
	walletId: z.string().min(1).max(250).describe('A guarded purchasing wallet'),
});

export const postWalletGuardReadTokenSchemaOutput = z.object({
	url: z.string().describe('Read-only hosted page for this wallet, carrying a wallet-scoped token'),
	expiresAt: z.string().describe('When the token in `url` stops working'),
});

async function findScopedWallet(walletId: string, ctx: { walletScopeIds: string[] | null; networkLimit: Network[] }) {
	const wallet = await prisma.hotWallet.findFirst({
		where: {
			AND: [buildHotWalletScopeFilter(ctx.walletScopeIds), { id: walletId }],
			deletedAt: null,
			PaymentSource: { deletedAt: null, network: { in: ctx.networkLimit } },
		},
		include: { GuardedWallet: true, PaymentSource: true },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Wallet not found');
	}
	return wallet;
}

function cosignFailure(error: unknown): never {
	if (error instanceof CosignTransportError) {
		throw createHttpError(error.status === 409 ? 409 : 502, error.message);
	}
	throw createHttpError(400, error instanceof Error ? error.message : String(error));
}

export const postWalletGuardEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postWalletGuardSchemaInput,
	output: postWalletGuardSchemaOutput,
	handler: async ({ input, ctx }) => {
		const wallet = await findScopedWallet(input.walletId, ctx);
		if (
			wallet.type !== HotWalletType.Purchasing ||
			wallet.PaymentSource.paymentSourceType !== PaymentSourceType.Web3CardanoV2
		) {
			throw createHttpError(400, 'Only a purchasing wallet of a Web3CardanoV2 payment source can be guarded');
		}
		if (wallet.GuardedWallet != null) {
			throw createHttpError(409, 'This wallet is already guarded');
		}
		if (input.agentKeyHash !== wallet.walletVkey) {
			throw createHttpError(400, 'agentKeyHash is not the key of this wallet');
		}
		if (input.quorumThreshold > new Set(input.quorumKeyHashes).size) {
			throw createHttpError(400, 'quorumThreshold exceeds the number of distinct quorum keys');
		}
		const network = convertNetwork(wallet.PaymentSource.network);
		const scriptHash = input.stateToken.split('.')[0];
		try {
			guardedWalletScript({ ...input, scriptHash }, network);
		} catch (error) {
			throw createHttpError(400, error instanceof Error ? error.message : String(error));
		}

		let registered;
		try {
			registered = await registerCosignWallet(cosignConfigFor(input), {
				walletAddress: input.walletAddress,
				stateToken: input.stateToken,
				ownerKeyHash: input.ownerKeyHash,
				agentKeyHashes: [input.agentKeyHash],
				quorumKeyHashes: input.quorumKeyHashes,
				quorumThreshold: input.quorumThreshold,
				escrowAddresses: [wallet.PaymentSource.smartContractAddress],
				governedAsset: { id: input.governedAsset, decimals: 6 },
				constitution: { template: input.template, params: input.params },
				network,
				orgId: input.orgId,
				nodeId: input.nodeId,
				registryGate: input.registryGate,
			});
		} catch (error) {
			cosignFailure(error);
		}

		const guarded = await prisma.guardedWallet.create({
			data: {
				hotWalletId: wallet.id,
				walletAddress: input.walletAddress,
				stateToken: input.stateToken,
				scriptHash,
				ownerKeyHash: input.ownerKeyHash,
				quorumKeyHashes: input.quorumKeyHashes,
				quorumThreshold: input.quorumThreshold,
				cosignBaseUrl: input.cosignBaseUrl,
				cosignTokenRef: input.cosignTokenRef,
				exchainWalletId: registered.walletId,
				nodeId: input.nodeId,
				orgId: input.orgId,
			},
		});
		return { ...guarded, walletId: wallet.id, mandateEnglish: registered.mandateEnglish };
	},
});

export const deleteWalletGuardEndpointDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteWalletGuardSchemaInput,
	output: deleteWalletGuardSchemaOutput,
	handler: async ({ input, ctx }) => {
		const wallet = await findScopedWallet(input.walletId, ctx);
		if (wallet.GuardedWallet == null) {
			throw createHttpError(404, 'This wallet is not guarded');
		}
		if (wallet.lockedAt != null || wallet.pendingTransactionId != null) {
			throw createHttpError(409, 'The wallet is funding a batch; retry when it is unlocked');
		}
		const guarded = await prisma.guardedWallet.delete({ where: { id: wallet.GuardedWallet.id } });
		return { ...guarded, walletId: wallet.id };
	},
});

export const postWalletGuardReadTokenEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postWalletGuardReadTokenSchemaInput,
	output: postWalletGuardReadTokenSchemaOutput,
	handler: async ({ input, ctx }) => {
		const wallet = await findScopedWallet(input.walletId, ctx);
		if (wallet.GuardedWallet == null) {
			throw createHttpError(404, 'This wallet is not guarded');
		}
		const guarded = wallet.GuardedWallet;
		try {
			const config = cosignConfigFor(guarded);
			const readToken = await mintCosignReadToken(config, guarded.exchainWalletId);
			return {
				url: `${config.url.replace(/\/+$/, '')}/protected/${guarded.exchainWalletId}?t=${encodeURIComponent(readToken.token)}`,
				expiresAt: readToken.expiresAt,
			};
		} catch (error) {
			cosignFailure(error);
		}
	},
});
