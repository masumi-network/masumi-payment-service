import canonicalStringify from 'canonical-json';
import createHttpError from 'http-errors';
import { createHash } from 'crypto';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { toClientEvmSigner, toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme as registerExactEvmClientScheme } from '@x402/evm/exact/client';
import { registerExactEvmScheme as registerExactEvmFacilitatorScheme } from '@x402/evm/exact/facilitator';
import {
	appendPaymentIdentifierToExtensions,
	extractAndValidatePaymentIdentifier,
	PAYMENT_IDENTIFIER,
} from '@x402/extensions/payment-identifier';
import {
	Prisma,
	X402EvmWalletType,
	X402PaymentDirection,
	X402PaymentScheme,
	X402PaymentStatus,
	prisma,
} from '@masumi/payment-core/db';
import { buildX402AttemptWhere } from './attempt-filters';
import { decrypt, encrypt } from '@masumi/payment-core/encryption';
import { logger } from '@masumi/payment-core/logger';
import { isAllowedCaip2Network } from '@masumi/payment-core/network';
import { createPublicClient, createWalletClient, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
	assertHexAddress,
	assertRpcServesDeclaredChain,
	assertSafeRpcUrl,
	createChain,
	getEip155ChainId,
	getManagedWalletOrThrow,
	getX402NetworkOrThrow,
	normalizeAddress,
	safeHttpTransport,
	type PrivateKey,
} from './internal';

// Wallet CRUD lives in ./wallets; re-exported so existing import sites
// (`@masumi/payment-source-x402`) and the service spec keep one entry point.
export {
	createX402ManagedWallet,
	deleteX402ManagedWallet,
	getX402ManagedWallet,
	listX402ManagedWallets,
	updateX402ManagedWallet,
} from './wallets';

const EXACT_SCHEME = 'exact';
const DEFAULT_X402_TIMEOUT_SECONDS = 300;
const PERMIT2_EXTRA = { assetTransferMethod: 'permit2' };

type X402SourceRecord = NonNullable<Awaited<ReturnType<typeof getX402SupportedPaymentSourceOrThrow>>>;

type X402RequirementExtra = {
	assetTransferMethod?: unknown;
	decimals?: unknown;
};

// Largest value the Postgres BigInt (signed 64-bit) settlement-amount column can hold.
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

// Parse an unsigned-integer string to BigInt, returning null for null/undefined or
// any non-integer form. Used for amounts that arrive from external services where a
// malformed value must not throw (e.g. after an irreversible on-chain settle).
// Also returns null for values that overflow the int64 column: the settle already
// happened on-chain, so recording a null amount is far better than throwing on the DB
// write and losing the settlement record entirely (the tx hash is the source of truth).
function parseUintStringOrNull(value: string | null | undefined): bigint | null {
	if (value == null || !/^\d+$/.test(value)) return null;
	const parsed = BigInt(value);
	if (parsed > POSTGRES_BIGINT_MAX) return null;
	return parsed;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
	const parsed: unknown = JSON.parse(
		JSON.stringify(value, (_key: string, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)),
	);
	return parsed as Prisma.InputJsonValue;
}

function toJsonObject(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject {
	if (value != null && typeof value === 'object' && !Array.isArray(value)) {
		return value;
	}
	return {};
}

function toRequirementExtra(value: unknown): X402RequirementExtra {
	if (value != null && typeof value === 'object' && !Array.isArray(value)) {
		return value as X402RequirementExtra;
	}
	return {};
}

export function hashX402PaymentPayload(paymentPayload: unknown): string {
	return createHash('sha256').update(canonicalStringify(paymentPayload)).digest('hex');
}

// The signed x402 payload embeds a reusable payment authorization (EIP-3009 / Permit2
// signature), so it is persisted encrypted at rest like every other wallet secret. It
// is a write-only audit record (never selected back by the service); decrypt with the
// configured key only for manual forensics. Stored as a JSON string in the Json column.
function encryptPaymentPayloadForStorage(paymentPayload: unknown): Prisma.InputJsonValue {
	return encrypt(canonicalStringify(paymentPayload));
}

function getPaymentIdentifier(paymentPayload: PaymentPayload): { id: string | null; errors: string[] } {
	const { id, validation } = extractAndValidatePaymentIdentifier(paymentPayload);
	return {
		id,
		errors: validation.valid ? [] : (validation.errors ?? ['Invalid payment-identifier extension']),
	};
}

function sourceToRequirements(source: X402SourceRecord): PaymentRequirements {
	if (source.scheme !== X402PaymentScheme.Exact) {
		throw createHttpError(400, 'Only x402 exact payment sources are supported');
	}
	if (source.asset == null || source.amount == null || source.payTo == null || source.decimals == null) {
		throw createHttpError(400, 'x402 supported payment source is incomplete');
	}

	return {
		scheme: EXACT_SCHEME,
		network: source.network as Network,
		asset: source.asset,
		amount: source.amount.toString(),
		payTo: source.payTo,
		maxTimeoutSeconds: DEFAULT_X402_TIMEOUT_SECONDS,
		extra: {
			...toJsonObject(source.extra),
			...PERMIT2_EXTRA,
			decimals: source.decimals,
		},
	};
}

function resourceMatchesRegisteredResource(registeredResource: string, candidate: string): boolean {
	return candidate === registeredResource;
}

function assertPaymentPayloadMatchesRegisteredResource(source: X402SourceRecord, paymentPayload: PaymentPayload) {
	if (source.resource == null) return;
	const payloadResourceUrl = paymentPayload.resource?.url;
	if (payloadResourceUrl == null) {
		throw createHttpError(400, 'x402 payment payload resource is required for this registered resource');
	}
	if (!resourceMatchesRegisteredResource(source.resource, payloadResourceUrl)) {
		throw createHttpError(400, 'x402 payment payload resource does not match the registered resource');
	}
}

async function getX402SupportedPaymentSourceOrThrow(supportedPaymentSourceId: string) {
	const source = await prisma.supportedPaymentSource.findUnique({
		where: { id: supportedPaymentSourceId },
		include: {
			RegistryRequest: {
				select: {
					id: true,
					apiBaseUrl: true,
					agentIdentifier: true,
				},
			},
		},
	});
	if (source == null || source.chain !== 'EVM') {
		throw createHttpError(404, 'x402 supported payment source not found');
	}
	return source;
}

async function getClientForWallet(walletId: string, caip2Network: string) {
	const [wallet, network] = await Promise.all([
		getManagedWalletOrThrow(walletId, X402EvmWalletType.Purchasing),
		getX402NetworkOrThrow(caip2Network),
	]);
	const privateKey = decrypt(wallet.encryptedPrivateKey) as PrivateKey;
	const account = privateKeyToAccount(privateKey);
	const chain = createChain(network.caip2Id, network.rpcUrl, network.displayName);
	const publicClient = createPublicClient({ chain, transport: safeHttpTransport(network.rpcUrl) });
	await assertRpcServesDeclaredChain(publicClient, network.caip2Id);
	const signer = toClientEvmSigner(account, publicClient);
	const client = new x402Client();
	const chainId = getEip155ChainId(network.caip2Id);

	registerExactEvmClientScheme(client, {
		signer,
		networks: [network.caip2Id as Network],
		schemeOptions: {
			[chainId]: { rpcUrl: network.rpcUrl },
		},
	});

	return {
		client,
		network,
		wallet,
		payer: account.address,
	};
}

async function getFacilitatorForNetwork(caip2Network: string) {
	const network = await getX402NetworkOrThrow(caip2Network);
	if (network.FacilitatorWallet == null) {
		throw createHttpError(400, 'x402 network has no facilitator wallet configured');
	}
	// A retired (soft-deleted) facilitator key must never sign settlements, even if it is
	// still attached to the network (e.g. re-assigned after deletion).
	if (network.FacilitatorWallet.deletedAt != null) {
		throw createHttpError(400, 'x402 network facilitator wallet has been retired');
	}
	// Defense-in-depth: a facilitator settles inbound payments, so it must be a Selling
	// wallet. Assignment is already gated in upsertX402Network, but enforce at use too in
	// case a wallet's role changed after it was wired up.
	if (network.FacilitatorWallet.type !== X402EvmWalletType.Selling) {
		throw createHttpError(400, 'x402 network facilitator wallet is not a Selling wallet');
	}

	const privateKey = decrypt(network.FacilitatorWallet.encryptedPrivateKey) as PrivateKey;
	const account = privateKeyToAccount(privateKey);
	const chain = createChain(network.caip2Id, network.rpcUrl, network.displayName);
	const walletClient = createWalletClient({ account, chain, transport: safeHttpTransport(network.rpcUrl) }).extend(
		publicActions,
	);
	await assertRpcServesDeclaredChain(walletClient, network.caip2Id);
	const facilitatorSigner = toFacilitatorEvmSigner(
		Object.assign(walletClient, {
			address: account.address,
		}) as Parameters<typeof toFacilitatorEvmSigner>[0],
	);
	const facilitator = new x402Facilitator();

	registerExactEvmFacilitatorScheme(facilitator, {
		signer: facilitatorSigner,
		networks: network.caip2Id as Network,
	});

	return facilitator;
}

async function reserveBudgetForAttempt({
	apiKeyId,
	evmWalletId,
	requirements,
	payer,
}: {
	apiKeyId: string;
	evmWalletId: string;
	requirements: PaymentRequirements;
	payer: string;
}) {
	const amount = BigInt(requirements.amount);
	const asset = normalizeAddress(requirements.asset);
	const payTo = normalizeAddress(requirements.payTo);
	const budgetAndAttempt = await prisma.$transaction(async (tx) => {
		const budget = await tx.x402WalletBudget.findFirst({
			where: {
				apiKeyId,
				evmWalletId,
				caip2Network: requirements.network,
				asset,
				enabled: true,
			},
			select: { id: true },
		});
		if (budget == null) {
			throw createHttpError(403, 'x402 wallet budget not found');
		}

		const updateResult = await tx.x402WalletBudget.updateMany({
			where: {
				id: budget.id,
				enabled: true,
				remainingAmount: { gte: amount },
			},
			data: {
				remainingAmount: { decrement: amount },
				spentAmount: { increment: amount },
			},
		});
		if (updateResult.count !== 1) {
			throw createHttpError(402, 'Insufficient x402 wallet budget');
		}

		const attempt = await tx.x402PaymentAttempt.create({
			data: {
				direction: X402PaymentDirection.OutboundPayment,
				status: X402PaymentStatus.PaymentRequired,
				apiKeyId,
				evmWalletId,
				caip2Network: requirements.network,
				scheme: X402PaymentScheme.Exact,
				asset,
				amount,
				payTo,
				payer,
			},
			select: { id: true },
		});

		return { budgetId: budget.id, attemptId: attempt.id, amount };
	});

	return budgetAndAttempt;
}

async function refundBudgetReservation(reservation: { budgetId: string; amount: bigint } | null) {
	if (reservation == null) return;
	// Guard the refund on the reservation still being reflected in spentAmount.
	// Without the `spentAmount >= amount` predicate, an admin budget reset
	// (setX402WalletBudget resets remainingAmount → fresh grant, spentAmount → 0)
	// that races an in-flight payment would let this refund inflate the fresh
	// grant beyond what the admin set AND drive spentAmount negative. If the guard
	// matches no row the reservation was already wiped by a reset — nothing to
	// refund.
	const result = await prisma.x402WalletBudget.updateMany({
		where: { id: reservation.budgetId, spentAmount: { gte: reservation.amount } },
		data: {
			remainingAmount: { increment: reservation.amount },
			spentAmount: { decrement: reservation.amount },
		},
	});
	if (result.count !== 1) {
		logger.warn('x402 budget refund skipped: reservation no longer reflected in spentAmount (budget reset?)', {
			budgetId: reservation.budgetId,
			amount: reservation.amount.toString(),
		});
	}
}

async function writeSettlement({
	attemptId,
	paymentPayloadHash,
	settleResponse,
}: {
	attemptId: string;
	paymentPayloadHash: string;
	settleResponse: SettleResponse;
}) {
	return prisma.x402Settlement.upsert({
		where: { paymentPayloadHash },
		create: {
			paymentAttemptId: attemptId,
			paymentPayloadHash,
			success: settleResponse.success,
			txHash: settleResponse.transaction,
			caip2Network: settleResponse.network,
			// Runs after the on-chain settle has already moved funds; a malformed facilitator
			// amount must not throw and lose the settlement record. Store null on bad input.
			amount: parseUintStringOrNull(settleResponse.amount),
			payer: settleResponse.payer,
			rawResponse: toJsonValue(settleResponse),
		},
		update: {},
	});
}

function requirementsMatch(a: PaymentRequirements, b: PaymentRequirements): boolean {
	// Match on every economically- and authorization-relevant field, including
	// maxTimeoutSeconds and the full `extra` (transfer method / EIP-712 domain), so
	// the signing policy pins to the exact selected variant and the SDK cannot sign a
	// different accepts[] entry that happens to share the core economics.
	return (
		a.scheme === b.scheme &&
		a.network === b.network &&
		normalizeAddress(a.asset) === normalizeAddress(b.asset) &&
		a.amount === b.amount &&
		normalizeAddress(a.payTo) === normalizeAddress(b.payTo) &&
		a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
		canonicalStringify(a.extra ?? {}) === canonicalStringify(b.extra ?? {})
	);
}

function assertRequirementsMatchRegisteredSource(requirements: PaymentRequirements, expected: PaymentRequirements) {
	const requirementsExtra = toRequirementExtra(requirements.extra);
	const expectedExtra = toRequirementExtra(expected.extra);
	if (
		requirements.scheme !== EXACT_SCHEME ||
		requirements.network !== expected.network ||
		normalizeAddress(requirements.asset) !== normalizeAddress(expected.asset) ||
		requirements.amount !== expected.amount ||
		normalizeAddress(requirements.payTo) !== normalizeAddress(expected.payTo) ||
		// Pin maxTimeoutSeconds too, mirroring requirementsMatch, so the signing window
		// cannot drift from the registered policy.
		requirements.maxTimeoutSeconds !== expected.maxTimeoutSeconds ||
		requirementsExtra.assetTransferMethod !== PERMIT2_EXTRA.assetTransferMethod ||
		// decimals arrives untyped from the wire (may be number or string); compare
		// by canonical string form so 6 and "6" are treated as equal.
		String(requirementsExtra.decimals) !== String(expectedExtra.decimals)
	) {
		throw createHttpError(400, 'Remote x402 payment requirements do not match the registered resource');
	}
}

function assertPayloadRequirementsMatchRegisteredSource(
	requirements: PaymentRequirements,
	expected: PaymentRequirements,
) {
	try {
		assertRequirementsMatchRegisteredSource(requirements, expected);
	} catch {
		throw createHttpError(400, 'x402 payment requirements do not match the registered resource');
	}
}

export async function listX402Networks(input?: { isTestnet?: boolean }) {
	const networks = await prisma.x402Network.findMany({
		// Split by environment at the query level: testnet chains belong to the Preprod
		// environment, mainnet chains to Mainnet. Undefined returns every chain.
		where: { isTestnet: input?.isTestnet },
		orderBy: { caip2Id: 'asc' },
		select: {
			id: true,
			caip2Id: true,
			displayName: true,
			rpcUrl: true,
			isTestnet: true,
			isEnabled: true,
			defaultAsset: true,
			facilitatorWalletId: true,
			// Denormalize the facilitator address so the UI can label chains
			// without loading the full managed-wallet set to resolve the id.
			FacilitatorWallet: { select: { address: true } },
			createdById: true,
			createdAt: true,
			updatedAt: true,
		},
	});
	return networks.map(({ FacilitatorWallet, ...network }) => ({
		...network,
		facilitatorWalletAddress: FacilitatorWallet?.address ?? null,
	}));
}

export async function upsertX402Network(input: {
	caip2Id: string;
	displayName: string;
	rpcUrl: string;
	isTestnet?: boolean;
	isEnabled?: boolean;
	defaultAsset?: string | null;
	facilitatorWalletId?: string | null;
	createdById?: string | null;
}) {
	getEip155ChainId(input.caip2Id);
	assertSafeRpcUrl(input.rpcUrl);
	if (input.defaultAsset != null) assertHexAddress(input.defaultAsset, 'defaultAsset');
	// A facilitator must reference a live Selling wallet. Validating here returns a clear
	// 404/400 (instead of an opaque FK 500) and stops a retired wallet — or a Purchasing
	// wallet — from being wired up as a settlement signer.
	if (input.facilitatorWalletId != null) {
		await getManagedWalletOrThrow(input.facilitatorWalletId, X402EvmWalletType.Selling);
	}

	const result = await prisma.x402Network.upsert({
		where: { caip2Id: input.caip2Id },
		create: {
			caip2Id: input.caip2Id,
			displayName: input.displayName,
			rpcUrl: input.rpcUrl,
			isTestnet: input.isTestnet ?? false,
			isEnabled: input.isEnabled ?? true,
			defaultAsset: input.defaultAsset,
			facilitatorWalletId: input.facilitatorWalletId,
			createdById: input.createdById,
		},
		// createdById is intentionally not updated — it records the original creator.
		update: {
			displayName: input.displayName,
			rpcUrl: input.rpcUrl,
			isTestnet: input.isTestnet,
			isEnabled: input.isEnabled,
			defaultAsset: input.defaultAsset,
			facilitatorWalletId: input.facilitatorWalletId,
		},
		select: {
			id: true,
			caip2Id: true,
			displayName: true,
			rpcUrl: true,
			isTestnet: true,
			isEnabled: true,
			defaultAsset: true,
			facilitatorWalletId: true,
			FacilitatorWallet: { select: { address: true } },
			createdById: true,
			createdAt: true,
			updatedAt: true,
		},
	});
	const { FacilitatorWallet, ...network } = result;
	return { ...network, facilitatorWalletAddress: FacilitatorWallet?.address ?? null };
}

export async function setX402WalletBudget(input: {
	apiKeyId: string;
	evmWalletId: string;
	caip2Network: string;
	asset: string;
	remainingAmount: string;
	createdById?: string | null;
}) {
	getEip155ChainId(input.caip2Network);
	assertHexAddress(input.asset, 'asset');
	const asset = normalizeAddress(input.asset);
	const remainingAmount = BigInt(input.remainingAmount);

	// Validate the referenced network, api key and wallet up front so a missing one returns
	// a clear 404 instead of an opaque foreign-key 500 from the upsert.
	const [network, apiKey] = await Promise.all([
		prisma.x402Network.findUnique({ where: { caip2Id: input.caip2Network }, select: { caip2Id: true } }),
		prisma.apiKey.findUnique({ where: { id: input.apiKeyId }, select: { id: true } }),
	]);
	if (network == null) {
		throw createHttpError(404, 'x402 network is not registered; add the network before granting a budget');
	}
	if (apiKey == null) {
		throw createHttpError(404, 'API key not found');
	}
	// Budgets fund outbound payments, so they may only be granted to a Purchasing wallet.
	await getManagedWalletOrThrow(input.evmWalletId, X402EvmWalletType.Purchasing);

	return prisma.x402WalletBudget.upsert({
		where: {
			apiKeyId_evmWalletId_caip2Network_asset: {
				apiKeyId: input.apiKeyId,
				evmWalletId: input.evmWalletId,
				caip2Network: input.caip2Network,
				asset,
			},
		},
		create: {
			apiKeyId: input.apiKeyId,
			evmWalletId: input.evmWalletId,
			caip2Network: input.caip2Network,
			asset,
			remainingAmount,
			spentAmount: 0n,
			createdById: input.createdById,
		},
		// createdById is intentionally not updated — it records who first set the budget.
		// Setting a budget replaces the remaining amount with a fresh grant, so reset
		// spentAmount too; otherwise "remaining + spent" no longer equals what was granted
		// and the Spent column keeps stale consumption from the previous grant.
		update: {
			remainingAmount,
			spentAmount: 0n,
		},
		select: {
			id: true,
			apiKeyId: true,
			evmWalletId: true,
			EvmWallet: { select: { address: true } },
			caip2Network: true,
			asset: true,
			remainingAmount: true,
			spentAmount: true,
			createdById: true,
			createdAt: true,
			updatedAt: true,
		},
	});
}

export async function listX402WalletBudgets(apiKeyId?: string) {
	return prisma.x402WalletBudget.findMany({
		where: { apiKeyId },
		orderBy: { createdAt: 'desc' },
		select: {
			id: true,
			apiKeyId: true,
			evmWalletId: true,
			EvmWallet: { select: { address: true } },
			caip2Network: true,
			asset: true,
			remainingAmount: true,
			spentAmount: true,
			createdById: true,
			createdAt: true,
			updatedAt: true,
		},
	});
}

export async function listX402PaymentAttempts(input: {
	take: number;
	cursorId?: string;
	status?: X402PaymentStatus;
	direction?: X402PaymentDirection;
	caip2Network?: string;
	filterNeedsManualAction?: boolean;
}) {
	// Explicit projection: never expose paymentPayload or encrypted material to the
	// dashboard.
	return prisma.x402PaymentAttempt.findMany({
		where: buildX402AttemptWhere(input),
		orderBy: { createdAt: 'desc' },
		take: input.take,
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		select: {
			id: true,
			createdAt: true,
			updatedAt: true,
			direction: true,
			status: true,
			apiKeyId: true,
			evmWalletId: true,
			registryRequestId: true,
			supportedPaymentSourceId: true,
			caip2Network: true,
			asset: true,
			amount: true,
			payTo: true,
			payer: true,
			resource: true,
			paymentIdentifier: true,
			errorReason: true,
			errorMessage: true,
			Settlement: {
				select: {
					id: true,
					success: true,
					txHash: true,
					amount: true,
					payer: true,
					createdAt: true,
				},
			},
		},
	});
}

export async function listX402Settlements(input: { take: number; cursorId?: string; caip2Network?: string }) {
	// Explicit projection: never expose rawResponse to the dashboard.
	return prisma.x402Settlement.findMany({
		where: { caip2Network: input.caip2Network },
		orderBy: { createdAt: 'desc' },
		take: input.take,
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		select: {
			id: true,
			createdAt: true,
			updatedAt: true,
			paymentAttemptId: true,
			success: true,
			txHash: true,
			caip2Network: true,
			amount: true,
			payer: true,
		},
	});
}

export async function verifyX402Payment({
	apiKeyId,
	caip2NetworkLimit,
	supportedPaymentSourceId,
	paymentPayload,
}: {
	apiKeyId: string;
	caip2NetworkLimit: string[] | null;
	supportedPaymentSourceId: string;
	paymentPayload: PaymentPayload;
}) {
	const source = await getX402SupportedPaymentSourceOrThrow(supportedPaymentSourceId);
	assertPaymentPayloadMatchesRegisteredResource(source, paymentPayload);
	const requirements = sourceToRequirements(source);
	if (!isAllowedCaip2Network(caip2NetworkLimit, requirements.network)) {
		throw createHttpError(401, 'Unauthorized network');
	}
	assertPayloadRequirementsMatchRegisteredSource(paymentPayload.accepted, requirements);
	const facilitator = await getFacilitatorForNetwork(requirements.network);
	const paymentPayloadHash = hashX402PaymentPayload(paymentPayload);
	const identifier = getPaymentIdentifier(paymentPayload);
	if (identifier.errors.length > 0) {
		throw createHttpError(400, identifier.errors.join('; '));
	}

	const verifyResponse = await facilitator.verify(paymentPayload, requirements);
	if (!verifyResponse.isValid) {
		logger.warn('x402 verify returned invalid', {
			supportedPaymentSourceId,
			paymentPayloadHash,
			invalidReason: verifyResponse.invalidReason,
			invalidMessage: verifyResponse.invalidMessage,
		});
	}
	const attempt = await prisma.x402PaymentAttempt.create({
		data: {
			direction: X402PaymentDirection.InboundVerify,
			status: verifyResponse.isValid ? X402PaymentStatus.Verified : X402PaymentStatus.Failed,
			apiKeyId,
			registryRequestId: source.registryRequestId,
			supportedPaymentSourceId,
			caip2Network: requirements.network,
			scheme: X402PaymentScheme.Exact,
			asset: requirements.asset,
			amount: BigInt(requirements.amount),
			payTo: requirements.payTo,
			payer: verifyResponse.payer,
			// Attribute to the registered resource only; the payload resource is buyer-supplied
			// and is unvalidated when the source pins no resource, so it must not be persisted.
			resource: source.resource,
			paymentPayloadHash,
			paymentPayload: encryptPaymentPayloadForStorage(paymentPayload),
			paymentIdentifier: identifier.id,
			errorReason: verifyResponse.invalidReason,
			errorMessage: verifyResponse.invalidMessage,
		},
		select: { id: true },
	});

	return {
		attemptId: attempt.id,
		paymentPayloadHash,
		paymentIdentifier: identifier.id,
		verifyResponse,
	};
}

export async function settleX402Payment({
	apiKeyId,
	caip2NetworkLimit,
	supportedPaymentSourceId,
	paymentPayload,
}: {
	apiKeyId: string;
	caip2NetworkLimit: string[] | null;
	supportedPaymentSourceId: string;
	paymentPayload: PaymentPayload;
}) {
	const source = await getX402SupportedPaymentSourceOrThrow(supportedPaymentSourceId);
	assertPaymentPayloadMatchesRegisteredResource(source, paymentPayload);
	const requirements = sourceToRequirements(source);
	if (!isAllowedCaip2Network(caip2NetworkLimit, requirements.network)) {
		throw createHttpError(401, 'Unauthorized network');
	}
	assertPayloadRequirementsMatchRegisteredSource(paymentPayload.accepted, requirements);
	const paymentPayloadHash = hashX402PaymentPayload(paymentPayload);
	const identifier = getPaymentIdentifier(paymentPayload);
	if (identifier.errors.length > 0) {
		throw createHttpError(400, identifier.errors.join('; '));
	}

	// Idempotency model: this dedup lookup plus the X402Settlement.paymentPayloadHash
	// unique constraint (writeSettlement is an upsert with an empty update) keep the
	// DB record single. The check-then-settle is not locked across the on-chain call,
	// so two concurrent settles of the SAME payload can both reach facilitator.settle;
	// the on-chain authorization is single-use (Permit2/EIP-3009 nonce), so the second
	// reverts on-chain — no double-spend, only a wasted tx. A cross-process lock would
	// have to hold a DB connection across the settle and is intentionally avoided.
	const existingSettlement = await prisma.x402Settlement.findUnique({
		where: { paymentPayloadHash },
		include: { PaymentAttempt: { select: { id: true, payer: true, supportedPaymentSourceId: true } } },
	});
	if (existingSettlement != null) {
		// Replay must be bound to the same registered source: the same on-chain
		// payment authorization (hence payload hash) settled for one source must not
		// return a fake success for a different source with identical economics.
		if (existingSettlement.PaymentAttempt.supportedPaymentSourceId !== supportedPaymentSourceId) {
			throw createHttpError(409, 'payment payload was already settled for a different registered resource');
		}
		const replayAttempt = await prisma.x402PaymentAttempt.create({
			data: {
				direction: X402PaymentDirection.InboundSettle,
				status: X402PaymentStatus.Replayed,
				apiKeyId,
				registryRequestId: source.registryRequestId,
				supportedPaymentSourceId,
				caip2Network: requirements.network,
				scheme: X402PaymentScheme.Exact,
				asset: requirements.asset,
				amount: BigInt(requirements.amount),
				payTo: requirements.payTo,
				payer: existingSettlement.payer ?? existingSettlement.PaymentAttempt.payer,
				// Registered resource only; never persist the buyer-supplied payload resource.
				resource: source.resource,
				paymentPayloadHash,
				paymentPayload: encryptPaymentPayloadForStorage(paymentPayload),
				paymentIdentifier: identifier.id,
			},
			select: { id: true },
		});

		return {
			attemptId: replayAttempt.id,
			paymentPayloadHash,
			paymentIdentifier: identifier.id,
			replay: true,
			settleResponse: {
				success: true,
				transaction: existingSettlement.txHash ?? '',
				network: existingSettlement.caip2Network as Network,
				amount: existingSettlement.amount?.toString(),
				payer: existingSettlement.payer ?? existingSettlement.PaymentAttempt.payer ?? undefined,
			},
		};
	}

	// Validate the facilitator wallet (retired / non-Selling → 400) BEFORE any
	// settle-prep work, so a bad wallet is rejected without querying for or
	// creating a pre-settle attempt row.
	const facilitator = await getFacilitatorForNetwork(requirements.network);

	// Crash-window guard: refuse to settle if a prior attempt for this exact
	// payload already reached the on-chain settle stage. A completed settlement
	// row would have been replayed above; a Verified pre-settle marker (or a
	// Settled attempt) with no settlement row means the previous settle either
	// crashed mid-flight or is racing this one. Re-settling would revert on-chain
	// (single-use Permit2/EIP-3009 nonce) and be recorded as a FALSE failure —
	// buyer charged, seller told it failed. Surface as needs-reconciliation.
	const priorSettleAttempt = await prisma.x402PaymentAttempt.findFirst({
		where: {
			paymentPayloadHash,
			direction: X402PaymentDirection.InboundSettle,
			status: { in: [X402PaymentStatus.Verified, X402PaymentStatus.Settled] },
		},
		select: { id: true },
	});
	if (priorSettleAttempt != null) {
		throw createHttpError(
			409,
			'a settlement for this payment payload is already in progress or awaiting reconciliation',
		);
	}

	// Durable pre-settle marker written BEFORE the irreversible on-chain settle.
	// If the process dies between facilitator.settle and the settlement write
	// below, this Verified row survives so the crash-window guard above blocks a
	// re-settle on the buyer's retry (the previous defect wrote NO record until
	// after settle, so a crash left funds moved with zero trace).
	const attempt = await prisma.x402PaymentAttempt.create({
		data: {
			direction: X402PaymentDirection.InboundSettle,
			status: X402PaymentStatus.Verified,
			apiKeyId,
			registryRequestId: source.registryRequestId,
			supportedPaymentSourceId,
			caip2Network: requirements.network,
			scheme: X402PaymentScheme.Exact,
			asset: requirements.asset,
			amount: BigInt(requirements.amount),
			payTo: requirements.payTo,
			// Registered resource only; never persist the buyer-supplied payload resource.
			resource: source.resource,
			paymentPayloadHash,
			paymentPayload: encryptPaymentPayloadForStorage(paymentPayload),
			paymentIdentifier: identifier.id,
		},
		select: { id: true },
	});

	// The facilitator's ordinary failure paths RETURN {success:false} (handled
	// below). But some paths THROW (a pre-broadcast verify-stage RPC failure, a
	// scheme mismatch, or a throw after the on-chain submit). A raw throw here
	// would leave the pre-settle Verified marker in place with NO error trace, so
	// the crash-window guard 409s every retry forever with nothing for an operator
	// to go on. Catch it, RECORD the error onto the marker so the stuck row is
	// discoverable (by errorReason), then re-throw.
	//
	// We deliberately do NOT auto-stamp Failed on a throw: a throw after the tx was
	// broadcast means funds already moved, and the on-chain authorization nonce is
	// single-use, so flipping to Failed would tell a charged buyer "failed" and let
	// a retry burn against a consumed nonce. Resolving that ambiguous case is an
	// operator/reconciliation decision, not an automatic one.
	let settleResponse: Awaited<ReturnType<typeof facilitator.settle>>;
	try {
		settleResponse = await facilitator.settle(paymentPayload, requirements);
	} catch (settleError) {
		const errorMessage = settleError instanceof Error ? settleError.message : String(settleError);
		await prisma.x402PaymentAttempt
			.update({
				where: { id: attempt.id },
				data: { errorReason: 'settle_threw', errorMessage },
			})
			.catch((recordError) => {
				logger.error('x402 settle threw AND recording the error on the attempt failed', {
					supportedPaymentSourceId,
					paymentPayloadHash,
					attemptId: attempt.id,
					recordError: recordError instanceof Error ? recordError.message : String(recordError),
				});
			});
		logger.error('x402 facilitator.settle threw; attempt left Verified for reconciliation', {
			supportedPaymentSourceId,
			paymentPayloadHash,
			attemptId: attempt.id,
			error: errorMessage,
		});
		throw settleError;
	}

	if (!settleResponse.success) {
		logger.warn('x402 settle returned unsuccessful', {
			supportedPaymentSourceId,
			paymentPayloadHash,
			errorReason: settleResponse.errorReason,
			errorMessage: settleResponse.errorMessage,
		});
	}

	// Stamp the outcome onto the pre-created attempt. On a legitimate settle
	// failure (nonce NOT consumed) this row becomes Failed, which the guard above
	// does NOT block — so a genuine retry can still proceed. If these post-settle
	// writes THROW after a SUCCESSFUL settle, funds already moved: keep the row
	// Verified (never auto-fail) and log loudly WITH the txHash so an operator can
	// confirm on-chain and reconcile.
	try {
		await prisma.x402PaymentAttempt.update({
			where: { id: attempt.id },
			data: {
				status: settleResponse.success ? X402PaymentStatus.Settled : X402PaymentStatus.Failed,
				payer: settleResponse.payer,
				errorReason: settleResponse.errorReason,
				errorMessage: settleResponse.errorMessage,
			},
		});

		if (settleResponse.success) {
			await writeSettlement({ attemptId: attempt.id, paymentPayloadHash, settleResponse });
		}
	} catch (writeError) {
		if (settleResponse.success) {
			logger.error('x402 settle SUCCEEDED but persisting the outcome failed; funds moved — needs reconciliation', {
				supportedPaymentSourceId,
				paymentPayloadHash,
				attemptId: attempt.id,
				txHash: settleResponse.transaction ?? null,
				error: writeError instanceof Error ? writeError.message : writeError,
			});
		}
		throw writeError;
	}

	return {
		attemptId: attempt.id,
		paymentPayloadHash,
		paymentIdentifier: identifier.id,
		replay: false,
		settleResponse,
		// Webhook-ready summary for the route handler to emit (settled or failed). Not part
		// of the HTTP response schema; the route strips it before responding.
		webhook: {
			attemptId: attempt.id,
			paymentPayloadHash,
			supportedPaymentSourceId,
			registryRequestId: source.registryRequestId,
			caip2Network: requirements.network,
			asset: requirements.asset,
			amount: requirements.amount,
			payTo: requirements.payTo,
			payer: settleResponse.payer ?? null,
			txHash: settleResponse.transaction ?? null,
			success: settleResponse.success,
			errorReason: settleResponse.errorReason ?? null,
			errorMessage: settleResponse.errorMessage ?? null,
		},
	};
}

export async function createX402Payment({
	apiKeyId,
	caip2NetworkLimit,
	evmWalletId,
	paymentRequired,
	preferredNetwork,
	preferredAsset,
	paymentIdentifier,
}: {
	apiKeyId: string;
	caip2NetworkLimit: string[] | null;
	evmWalletId: string;
	paymentRequired: PaymentRequired;
	preferredNetwork?: string;
	preferredAsset?: string;
	paymentIdentifier?: string;
}) {
	const accepts = paymentRequired.accepts;
	if (!Array.isArray(accepts) || accepts.length === 0) {
		throw createHttpError(400, 'x402 paymentRequired.accepts must list at least one payment requirement');
	}

	// Restrict to requirements this service can sign: exact EVM scheme on a network
	// allowed for this API key, optionally narrowed by the caller's preference.
	const candidates = accepts.filter((requirement) => {
		if (requirement.scheme !== EXACT_SCHEME) return false;
		// Defense-in-depth: the amount must be a positive unsigned integer before it
		// reaches BigInt()/budget math. A negative value would invert the budget
		// decrement (minting budget); a non-numeric value would throw.
		if (!/^\d+$/.test(requirement.amount) || BigInt(requirement.amount) <= 0n) return false;
		if (!/^eip155:\d+$/.test(requirement.network)) return false;
		if (!isAllowedCaip2Network(caip2NetworkLimit, requirement.network)) return false;
		if (preferredNetwork != null && requirement.network !== preferredNetwork) return false;
		if (preferredAsset != null && normalizeAddress(requirement.asset) !== normalizeAddress(preferredAsset)) {
			return false;
		}
		return true;
	});
	if (candidates.length === 0) {
		throw createHttpError(400, 'No forwarded x402 requirement matches an allowed network/asset for this API key');
	}

	// Select the first candidate whose network is enabled and that has a funded
	// budget for this (apiKey, wallet, network, asset).
	let selectedRequirement: PaymentRequirements | null = null;
	for (const candidate of candidates) {
		const candidateNetwork = await prisma.x402Network.findUnique({
			where: { caip2Id: candidate.network },
			select: { isEnabled: true },
		});
		if (candidateNetwork == null || !candidateNetwork.isEnabled) continue;

		const budget = await prisma.x402WalletBudget.findFirst({
			where: {
				apiKeyId,
				evmWalletId,
				caip2Network: candidate.network,
				asset: normalizeAddress(candidate.asset),
				enabled: true,
				remainingAmount: { gte: BigInt(candidate.amount) },
			},
			select: { id: true },
		});
		if (budget == null) continue;

		selectedRequirement = candidate;
		break;
	}
	if (selectedRequirement == null) {
		throw createHttpError(402, 'No managed wallet budget can cover the forwarded x402 payment requirements');
	}
	const selected = selectedRequirement;

	const { client, payer } = await getClientForWallet(evmWalletId, selected.network);

	// Pin the client to the single requirement we selected and budgeted for, so the
	// default selector cannot sign a different (e.g. costlier) option from accepts[].
	client.registerPolicy((_version, requirements) => {
		const matching = requirements.filter((option) => requirementsMatch(option, selected));
		if (matching.length === 0) {
			throw createHttpError(400, 'x402 payment requirements changed before signing');
		}
		return matching;
	});

	if (paymentIdentifier != null) {
		client.registerExtension({
			key: PAYMENT_IDENTIFIER,
			enrichPaymentPayload: async (signedPayload, declaredPaymentRequired) => {
				if (declaredPaymentRequired.extensions?.[PAYMENT_IDENTIFIER] == null) {
					return signedPayload;
				}
				return {
					...signedPayload,
					extensions: appendPaymentIdentifierToExtensions({ ...(signedPayload.extensions ?? {}) }, paymentIdentifier),
				};
			},
		});
	}

	const reservation = await reserveBudgetForAttempt({ apiKeyId, evmWalletId, requirements: selected, payer });

	try {
		// Local signing only — this service never sends the buyer's request. The agent
		// retries its own request with the returned X-PAYMENT header.
		const paymentPayload = await client.createPaymentPayload(paymentRequired);
		const xPaymentHeader = encodePaymentSignatureHeader(paymentPayload);
		const paymentPayloadHash = hashX402PaymentPayload(paymentPayload);
		const identifier = getPaymentIdentifier(paymentPayload);
		if (identifier.errors.length > 0) {
			throw createHttpError(400, identifier.errors.join('; '));
		}
		// If the caller asked to tag the payment but the forwarded 402 does not declare
		// the payment-identifier extension, surface it rather than silently dropping it.
		if (paymentIdentifier != null && identifier.id == null) {
			throw createHttpError(400, 'The forwarded 402 does not advertise the payment-identifier extension');
		}

		await prisma.x402PaymentAttempt.update({
			where: { id: reservation.attemptId },
			data: {
				status: X402PaymentStatus.Verified,
				resource: paymentPayload.resource?.url,
				paymentPayloadHash,
				paymentPayload: encryptPaymentPayloadForStorage(paymentPayload),
				paymentIdentifier: identifier.id,
			},
		});

		return {
			attemptId: reservation.attemptId,
			payer,
			caip2Network: selected.network,
			asset: normalizeAddress(selected.asset),
			amount: selected.amount,
			payTo: normalizeAddress(selected.payTo),
			xPaymentHeader,
			paymentPayload,
			paymentPayloadHash,
			paymentIdentifier: identifier.id,
		};
	} catch (error) {
		// Refund first so that a failure to record the Failed status can never leak the
		// reserved budget; the status update is best-effort and must not mask the error.
		await refundBudgetReservation(reservation);
		await prisma.x402PaymentAttempt
			.update({
				where: { id: reservation.attemptId },
				data: {
					status: X402PaymentStatus.Failed,
					errorReason: 'x402_sign_failed',
					// Generic, user-safe message only. The raw error (which can embed the
					// configured RPC URL / request internals) is re-thrown below and logged
					// server-side by the route's error handler — it is never persisted here.
					errorMessage: 'x402 payment signing failed',
				},
			})
			.catch((updateError: unknown) => {
				logger.error('x402 failed to record Failed status after refunding reservation', {
					attemptId: reservation.attemptId,
					error: updateError,
				});
			});
		// Intentional HttpErrors (e.g. a 400 validation reject thrown above) carry a
		// safe, deliberate message and status — propagate them unchanged. Only unexpected
		// errors (raw signing/RPC failures, which can embed the configured RPC URL) are
		// sanitized so those internals can never reach the caller.
		if (createHttpError.isHttpError(error)) {
			throw error;
		}
		logger.error('x402 payment signing failed', { attemptId: reservation.attemptId, error });
		throw createHttpError(500, 'x402 payment signing failed');
	}
}
