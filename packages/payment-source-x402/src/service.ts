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
import { Prisma, X402PaymentDirection, X402PaymentScheme, X402PaymentStatus, prisma } from '@masumi/payment-core/db';
import { decrypt, encrypt } from '@masumi/payment-core/encryption';
import { isAllowedCaip2Network } from '@masumi/payment-core/network';
import { createPublicClient, createWalletClient, defineChain, http, publicActions } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const EXACT_SCHEME = 'exact';
const DEFAULT_X402_TIMEOUT_SECONDS = 300;
const PERMIT2_EXTRA = { assetTransferMethod: 'permit2' };

type HexAddress = `0x${string}`;
type PrivateKey = `0x${string}`;

type X402SourceRecord = NonNullable<Awaited<ReturnType<typeof getX402SupportedPaymentSourceOrThrow>>>;

type X402RequirementExtra = {
	assetTransferMethod?: unknown;
	decimals?: unknown;
};

function getEip155ChainId(caip2Network: string): number {
	const match = /^eip155:(\d+)$/.exec(caip2Network);
	if (match == null) {
		throw createHttpError(400, 'x402 network must be a CAIP-2 eip155 chain id');
	}
	const chainId = Number(match[1]);
	// Guard against silent precision loss feeding the wrong chain id to viem.
	if (!Number.isSafeInteger(chainId) || chainId <= 0) {
		throw createHttpError(400, 'x402 eip155 chain id is out of range');
	}
	return chainId;
}

function normalizeAddress(value: string): string {
	return value.toLowerCase();
}

function assertHexAddress(value: string, label: string): asserts value is HexAddress {
	if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
		throw createHttpError(400, `${label} must be an EVM address`);
	}
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

function createChain(caip2Network: string, rpcUrl: string, displayName: string) {
	const chainId = getEip155ChainId(caip2Network);

	return defineChain({
		id: chainId,
		name: displayName,
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: {
			default: { http: [rpcUrl] },
		},
	});
}

export function hashX402PaymentPayload(paymentPayload: unknown): string {
	return createHash('sha256').update(canonicalStringify(paymentPayload)).digest('hex');
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

async function getX402NetworkOrThrow(caip2Network: string) {
	const network = await prisma.x402Network.findUnique({
		where: { caip2Id: caip2Network },
		include: {
			FacilitatorWallet: true,
		},
	});
	if (network == null || !network.isEnabled) {
		throw createHttpError(404, 'x402 network is not enabled');
	}
	return network;
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

async function getManagedWalletOrThrow(evmWalletId: string) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	return wallet;
}

async function getClientForWallet(walletId: string, caip2Network: string) {
	const [wallet, network] = await Promise.all([getManagedWalletOrThrow(walletId), getX402NetworkOrThrow(caip2Network)]);
	const privateKey = decrypt(wallet.encryptedPrivateKey) as PrivateKey;
	const account = privateKeyToAccount(privateKey);
	const chain = createChain(network.caip2Id, network.rpcUrl, network.displayName);
	const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });
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

	const privateKey = decrypt(network.FacilitatorWallet.encryptedPrivateKey) as PrivateKey;
	const account = privateKeyToAccount(privateKey);
	const chain = createChain(network.caip2Id, network.rpcUrl, network.displayName);
	const walletClient = createWalletClient({ account, chain, transport: http(network.rpcUrl) }).extend(publicActions);
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
	await prisma.x402WalletBudget.update({
		where: { id: reservation.budgetId },
		data: {
			remainingAmount: { increment: reservation.amount },
			spentAmount: { decrement: reservation.amount },
		},
	});
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
			amount: settleResponse.amount != null ? BigInt(settleResponse.amount) : null,
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
		requirementsExtra.assetTransferMethod !== PERMIT2_EXTRA.assetTransferMethod ||
		// decimals arrives untyped from the wire (may be number or string); compare
		// by canonical string form so 6 and "6" are treated as equal.
		String(requirementsExtra.decimals) !== String(expectedExtra.decimals)
	) {
		throw new Error('Remote x402 payment requirements do not match the registered resource');
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

export async function createX402ManagedWallet({
	createdByApiKeyId,
	privateKey,
}: {
	createdByApiKeyId: string;
	privateKey?: string;
}) {
	const walletPrivateKey = (privateKey ?? generatePrivateKey()) as PrivateKey;
	const account = privateKeyToAccount(walletPrivateKey);

	const wallet = await prisma.x402EvmWallet.create({
		data: {
			address: account.address,
			encryptedPrivateKey: encrypt(walletPrivateKey),
			createdById: createdByApiKeyId,
		},
		select: {
			id: true,
			address: true,
			createdAt: true,
			updatedAt: true,
			createdById: true,
		},
	});

	return wallet;
}

export async function listX402ManagedWallets() {
	return prisma.x402EvmWallet.findMany({
		where: { deletedAt: null },
		orderBy: { createdAt: 'desc' },
		select: {
			id: true,
			address: true,
			createdAt: true,
			updatedAt: true,
			createdById: true,
		},
	});
}

export async function listX402Networks() {
	return prisma.x402Network.findMany({
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
			createdById: true,
			createdAt: true,
			updatedAt: true,
		},
	});
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
	if (input.defaultAsset != null) assertHexAddress(input.defaultAsset, 'defaultAsset');

	return prisma.x402Network.upsert({
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
			createdById: true,
			createdAt: true,
			updatedAt: true,
		},
	});
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
		update: {
			remainingAmount,
		},
		select: {
			id: true,
			apiKeyId: true,
			evmWalletId: true,
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
}) {
	// Explicit projection: never expose paymentPayload or encrypted material to the
	// dashboard.
	return prisma.x402PaymentAttempt.findMany({
		where: {
			status: input.status,
			direction: input.direction,
			caip2Network: input.caip2Network,
		},
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
			resource: paymentPayload.resource?.url ?? source.resource,
			paymentPayloadHash,
			paymentPayload: toJsonValue(paymentPayload),
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
				resource: paymentPayload.resource?.url ?? source.resource,
				paymentPayloadHash,
				paymentPayload: toJsonValue(paymentPayload),
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

	const facilitator = await getFacilitatorForNetwork(requirements.network);
	const settleResponse = await facilitator.settle(paymentPayload, requirements);
	const attempt = await prisma.x402PaymentAttempt.create({
		data: {
			direction: X402PaymentDirection.InboundSettle,
			status: settleResponse.success ? X402PaymentStatus.Settled : X402PaymentStatus.Failed,
			apiKeyId,
			registryRequestId: source.registryRequestId,
			supportedPaymentSourceId,
			caip2Network: requirements.network,
			scheme: X402PaymentScheme.Exact,
			asset: requirements.asset,
			amount: BigInt(requirements.amount),
			payTo: requirements.payTo,
			payer: settleResponse.payer,
			resource: paymentPayload.resource?.url ?? source.resource,
			paymentPayloadHash,
			paymentPayload: toJsonValue(paymentPayload),
			paymentIdentifier: identifier.id,
			errorReason: settleResponse.errorReason,
			errorMessage: settleResponse.errorMessage,
		},
		select: { id: true },
	});

	if (settleResponse.success) {
		await writeSettlement({ attemptId: attempt.id, paymentPayloadHash, settleResponse });
	}

	return {
		attemptId: attempt.id,
		paymentPayloadHash,
		paymentIdentifier: identifier.id,
		replay: false,
		settleResponse,
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
				paymentPayload: toJsonValue(paymentPayload),
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
					errorMessage: error instanceof Error ? error.message : String(error),
				},
			})
			.catch(() => undefined);
		throw error;
	}
}

export async function deleteX402ManagedWallet(evmWalletId: string) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
		select: { id: true },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}

	// Soft-delete the wallet, disable its budgets, and detach it from any network it
	// facilitates, so a retired/compromised key can no longer sign or settle.
	await prisma.$transaction([
		prisma.x402EvmWallet.update({ where: { id: evmWalletId }, data: { deletedAt: new Date() } }),
		prisma.x402WalletBudget.updateMany({ where: { evmWalletId }, data: { enabled: false } }),
		prisma.x402Network.updateMany({
			where: { facilitatorWalletId: evmWalletId },
			data: { facilitatorWalletId: null },
		}),
	]);

	return { id: evmWalletId };
}
