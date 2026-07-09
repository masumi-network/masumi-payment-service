import createHttpError from 'http-errors';
import { Prisma, X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { encrypt } from '@masumi/payment-core/encryption';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assertX402WalletCustody, buildX402WalletCustodyWhere, type X402WalletCustodyScope } from './custody.js';
import { assertValidPrivateKey } from './internal';

// The non-secret projection returned to the dashboard for every managed wallet. The
// encrypted private key is never part of this set; the plaintext key is only ever
// returned once, by createX402ManagedWallet, for backup.
const WALLET_OUTPUT_SELECT = {
	id: true,
	address: true,
	type: true,
	note: true,
	createdAt: true,
	updatedAt: true,
	createdById: true,
} satisfies Prisma.X402EvmWalletSelect;

export async function createX402ManagedWallet({
	createdByApiKeyId,
	type,
	note,
	privateKey,
}: {
	createdByApiKeyId: string;
	type: X402EvmWalletType;
	note?: string | null;
	privateKey?: string;
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

	try {
		const created = await prisma.x402EvmWallet.create({
			data: {
				address: account.address,
				type,
				note: note ?? null,
				encryptedPrivateKey: encrypt(walletPrivateKey),
				createdById: createdByApiKeyId,
			},
			select: WALLET_OUTPUT_SELECT,
		});
		// One-time backup secret. Never persisted in plaintext, never retrievable again.
		return { ...created, privateKey: wasGenerated ? walletPrivateKey : null };
	} catch (error) {
		// address is @unique (including soft-deleted rows), so importing a key whose address
		// already exists surfaces a clear 409 instead of an opaque Prisma 500.
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
			throw createHttpError(409, 'A managed EVM wallet with this address already exists');
		}
		throw error;
	}
}

export async function listX402ManagedWallets(input?: {
	take?: number;
	cursorId?: string;
	type?: X402EvmWalletType;
	custodyScope?: X402WalletCustodyScope;
}) {
	const custodyScope = input?.custodyScope ?? null;
	return prisma.x402EvmWallet.findMany({
		where: {
			deletedAt: null,
			type: input?.type,
			...buildX402WalletCustodyWhere(custodyScope),
		},
		orderBy: { createdAt: 'desc' },
		take: input?.take,
		cursor: input?.cursorId ? { id: input.cursorId } : undefined,
		select: WALLET_OUTPUT_SELECT,
	});
}

export async function getX402ManagedWallet(evmWalletId: string, custodyScope?: X402WalletCustodyScope) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
		select: WALLET_OUTPUT_SELECT,
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertX402WalletCustody(custodyScope ?? null, wallet);
	return wallet;
}

export async function updateX402ManagedWallet(input: {
	id: string;
	note?: string | null;
	custodyScope?: X402WalletCustodyScope;
}) {
	// Only the human-facing note is mutable; address/type/key are immutable for an
	// existing wallet (changing them would change which on-chain account it controls).
	const existing = await prisma.x402EvmWallet.findUnique({
		where: { id: input.id, deletedAt: null },
		select: WALLET_OUTPUT_SELECT,
	});
	if (existing == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertX402WalletCustody(input.custodyScope ?? null, existing);
	return prisma.x402EvmWallet.update({
		where: { id: input.id },
		data: { note: input.note ?? null },
		select: WALLET_OUTPUT_SELECT,
	});
}

export async function deleteX402ManagedWallet(evmWalletId: string, custodyScope?: X402WalletCustodyScope) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
		select: WALLET_OUTPUT_SELECT,
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertX402WalletCustody(custodyScope ?? null, wallet);

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
