import createHttpError from 'http-errors';
import { Prisma, X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { isUniqueConstraintError } from '@masumi/payment-core/db-retry';
import { encrypt } from '@masumi/payment-core/encryption';
import { isAllowedCaip2Network } from '@masumi/payment-core/network';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assertValidPrivateKey, assertWalletOwner, buildOwnerScopeWhere, type X402OwnerScope } from './internal';

// The non-secret projection returned to the dashboard for every managed wallet. The
// encrypted private key is never part of this set; the plaintext key is only ever
// returned once, by createX402ManagedWallet, for backup. The bound network is exposed as
// the flat caip2Network string (see flattenWallet) so callers keep a stable wire shape.
const WALLET_OUTPUT_SELECT = {
	id: true,
	networkId: true,
	address: true,
	type: true,
	note: true,
	createdAt: true,
	updatedAt: true,
	createdById: true,
	Network: { select: { caip2Id: true } },
} satisfies Prisma.X402EvmWalletSelect;

type WalletOutputRow = Prisma.X402EvmWalletGetPayload<{ select: typeof WALLET_OUTPUT_SELECT }>;

function flattenWallet({ Network, ...wallet }: WalletOutputRow) {
	return { ...wallet, caip2Network: Network.caip2Id };
}

function assertWalletNetworkAllowed(caip2NetworkLimit: string[] | null, caip2Network: string) {
	// Match the ownership guard's 404 semantics so a scoped key cannot use wallet endpoints
	// to discover that a wallet exists on a network outside its access limit.
	if (!isAllowedCaip2Network(caip2NetworkLimit, caip2Network)) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
}

export async function createX402ManagedWallet({
	createdByApiKeyId,
	networkId,
	type,
	note,
	privateKey,
	caip2NetworkLimit = null,
}: {
	createdByApiKeyId: string;
	networkId: string;
	type: X402EvmWalletType;
	note?: string | null;
	privateKey?: string;
	caip2NetworkLimit?: string[] | null;
}) {
	// A server-generated key is the only copy that exists in plaintext, so it is returned
	// once below for the operator to back up. A caller-supplied key is never echoed back —
	// they already hold it.
	const wasGenerated = privateKey == null;
	const walletPrivateKey = privateKey ?? generatePrivateKey();
	// Validate here (not only in the route schema) so any caller of this function is
	// protected before the key reaches viem and is encrypted at rest.
	assertValidPrivateKey(walletPrivateKey);
	const account = privateKeyToAccount(walletPrivateKey);

	// A wallet is bound to exactly one payment source (network); reject an unknown one up
	// front with a clear 404 instead of an opaque foreign-key 500.
	const network = await prisma.x402Network.findUnique({
		where: { id: networkId },
		select: { id: true, caip2Id: true },
	});
	if (network == null || !isAllowedCaip2Network(caip2NetworkLimit, network.caip2Id)) {
		throw createHttpError(404, 'x402 network is not registered; add the network before creating a wallet');
	}

	// The address is deterministic from the key while encryption is non-deterministic. Keep
	// that public identity on X402WalletSecret and let its unique index serialize concurrent
	// first imports on different networks. Prisma upsert is a find-then-create with the pg
	// adapter, so use native ON CONFLICT and then resolve the winner in a fresh statement.
	await prisma.$executeRaw`
		INSERT INTO "X402WalletSecret" ("id", "updatedAt", "address", "encryptedPrivateKey")
		VALUES (gen_random_uuid()::text, now(), ${account.address}, ${encrypt(walletPrivateKey)})
		ON CONFLICT ("address") DO NOTHING
	`;
	const secret = await prisma.x402WalletSecret.findUniqueOrThrow({
		where: { address: account.address },
		select: { id: true },
	});

	try {
		const created = await prisma.x402EvmWallet.create({
			// Nested relation writes require the checked form, so the network and creator are
			// connected as relations rather than via scalar FKs.
			data: {
				Network: { connect: { id: networkId } },
				address: account.address,
				type,
				note: note ?? null,
				CreatedBy: { connect: { id: createdByApiKeyId } },
				Secret: { connect: { id: secret.id } },
			},
			select: WALLET_OUTPUT_SELECT,
		});
		// One-time backup secret. Never persisted in plaintext, never retrievable again.
		return { ...flattenWallet(created), privateKey: wasGenerated ? walletPrivateKey : null };
	} catch (error) {
		// (networkId, address) is unique, so importing a key already bound to this network
		// surfaces a clear 409 instead of an opaque Prisma 500.
		if (isUniqueConstraintError(error)) {
			throw createHttpError(409, 'A managed EVM wallet with this address already exists on this network');
		}
		throw error;
	}
}

export async function listX402ManagedWallets(input?: {
	take?: number;
	cursorId?: string;
	type?: X402EvmWalletType;
	networkId?: string;
	ownerScope?: X402OwnerScope;
	caip2NetworkLimit?: string[] | null;
}) {
	const wallets = await prisma.x402EvmWallet.findMany({
		where: {
			deletedAt: null,
			type: input?.type,
			networkId: input?.networkId,
			Network: input?.caip2NetworkLimit == null ? undefined : { caip2Id: { in: input.caip2NetworkLimit } },
			...buildOwnerScopeWhere(input?.ownerScope ?? null),
		},
		orderBy: { createdAt: 'desc' },
		take: input?.take,
		cursor: input?.cursorId ? { id: input.cursorId } : undefined,
		select: WALLET_OUTPUT_SELECT,
	});
	return wallets.map(flattenWallet);
}

export async function getX402ManagedWallet(
	evmWalletId: string,
	ownerScope: X402OwnerScope = null,
	caip2NetworkLimit: string[] | null = null,
) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
		select: WALLET_OUTPUT_SELECT,
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertWalletOwner(ownerScope, wallet);
	assertWalletNetworkAllowed(caip2NetworkLimit, wallet.Network.caip2Id);
	return flattenWallet(wallet);
}

export async function updateX402ManagedWallet(input: {
	id: string;
	note?: string | null;
	ownerScope?: X402OwnerScope;
	caip2NetworkLimit?: string[] | null;
}) {
	// Only the human-facing note is mutable; address/type/key are immutable for an
	// existing wallet (changing them would change which on-chain account it controls).
	const existing = await prisma.x402EvmWallet.findUnique({
		where: { id: input.id, deletedAt: null },
		select: { id: true, createdById: true, Network: { select: { caip2Id: true } } },
	});
	if (existing == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertWalletOwner(input.ownerScope ?? null, existing);
	assertWalletNetworkAllowed(input.caip2NetworkLimit ?? null, existing.Network.caip2Id);
	const updated = await prisma.x402EvmWallet.update({
		where: { id: input.id },
		data: { note: input.note ?? null },
		select: WALLET_OUTPUT_SELECT,
	});
	return flattenWallet(updated);
}

export async function deleteX402ManagedWallet(
	evmWalletId: string,
	ownerScope: X402OwnerScope = null,
	caip2NetworkLimit: string[] | null = null,
) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
		select: { id: true, createdById: true, Network: { select: { caip2Id: true } } },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertWalletOwner(ownerScope, wallet);
	assertWalletNetworkAllowed(caip2NetworkLimit, wallet.Network.caip2Id);

	// Soft-delete the wallet, disable its budgets and low-balance rules, and detach it
	// from any network it facilitates, so a retired/compromised key can no longer sign,
	// settle or raise alerts.
	await prisma.$transaction([
		prisma.x402EvmWallet.update({ where: { id: evmWalletId }, data: { deletedAt: new Date() } }),
		prisma.x402WalletBudget.updateMany({ where: { evmWalletId }, data: { enabled: false } }),
		prisma.x402EvmWalletLowBalanceRule.updateMany({ where: { evmWalletId }, data: { enabled: false } }),
		prisma.x402Network.updateMany({
			where: { facilitatorWalletId: evmWalletId },
			data: { facilitatorWalletId: null },
		}),
	]);

	return { id: evmWalletId };
}
