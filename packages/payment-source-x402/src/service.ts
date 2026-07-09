import canonicalStringify from 'canonical-json';
import createHttpError from 'http-errors';
import { createHash } from 'crypto';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import {
	appendPaymentIdentifierToExtensions,
	extractAndValidatePaymentIdentifier,
	PAYMENT_IDENTIFIER,
} from '@x402/extensions/payment-identifier';
import {
	Prisma,
	X402CounterpartyRole,
	X402EvmWalletType,
	X402PaymentDirection,
	X402PaymentScheme,
	X402PaymentStatus,
	prisma,
} from '@masumi/payment-core/db';
import { encrypt } from '@masumi/payment-core/encryption';
import { logger } from '@masumi/payment-core/logger';
import { isAllowedCaip2Network } from '@masumi/payment-core/network';
import { getClientForWallet, getFacilitatorForNetwork } from './facilitator';
import { getManagedWalletOrThrow, normalizeAddress, upsertCounterpartyWalletId } from './internal';
import { withFacilitatorSettleLock } from './settle-lock';
import {
	assertPayloadRequirementsMatchRegisteredSource,
	assertPaymentPayloadMatchesRegisteredResource,
	EXACT_SCHEME,
	getX402SupportedPaymentSourceOrThrow,
	requirementsMatch,
	sourceToRequirements,
} from './requirements';

// Wallet CRUD lives in ./wallets; network/budget CRUD in ./networks; attempt/settlement list
// projections in ./queries. Re-exported so existing import sites (`@masumi/payment-source-x402`)
// and the service spec keep one entry point.
export {
	createX402ManagedWallet,
	deleteX402ManagedWallet,
	getX402ManagedWallet,
	listX402ManagedWallets,
	updateX402ManagedWallet,
} from './wallets';
export { listX402Networks, listX402WalletBudgets, setX402WalletBudget, upsertX402Network } from './networks';
export { listX402PaymentAttempts, listX402Settlements } from './queries';
export { reconcileX402PaymentAttempt } from './reconcile';

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

// Reserve budget for an outbound payment and create the PaymentRequired attempt in one
// transaction. Network is structural (networkId, already validated to match the wallet's
// binding by the caller); the counterparty (payTo) is recorded as a Payee entity. The own
// wallet's address is not duplicated onto the row — it lives on EvmWallet.
async function reserveBudgetForAttempt({
	apiKeyId,
	evmWalletId,
	networkId,
	requirements,
}: {
	apiKeyId: string;
	evmWalletId: string;
	networkId: string;
	requirements: PaymentRequirements;
}) {
	const amount = BigInt(requirements.amount);
	const asset = normalizeAddress(requirements.asset);
	const payTo = normalizeAddress(requirements.payTo);
	const budgetAndAttempt = await prisma.$transaction(async (tx) => {
		const budget = await tx.x402WalletBudget.findFirst({
			where: {
				apiKeyId,
				evmWalletId,
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

		const counterpartyWalletId = await upsertCounterpartyWalletId(tx, {
			caip2Network: requirements.network,
			address: payTo,
			role: X402CounterpartyRole.Payee,
		});

		const attempt = await tx.x402PaymentAttempt.create({
			data: {
				direction: X402PaymentDirection.OutboundPayment,
				status: X402PaymentStatus.PaymentRequired,
				apiKeyId,
				networkId,
				evmWalletId,
				counterpartyWalletId,
				scheme: X402PaymentScheme.Exact,
				asset,
				amount,
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
	// Network + payer are derivable from the linked attempt (Network + CounterpartyWallet);
	// the facilitator-reported originals are kept in rawResponse for audit.
	return prisma.x402Settlement.upsert({
		where: { paymentPayloadHash },
		create: {
			paymentAttemptId: attemptId,
			paymentPayloadHash,
			success: settleResponse.success,
			txHash: settleResponse.transaction,
			// Runs after the on-chain settle has already moved funds; a malformed facilitator
			// amount must not throw and lose the settlement record. Store null on bad input.
			amount: parseUintStringOrNull(settleResponse.amount),
			rawResponse: toJsonValue(settleResponse),
		},
		update: {},
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
	const { facilitator, network } = await getFacilitatorForNetwork(requirements.network);
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
	// The buyer (payer) is the counterparty on the sell side; record it as a Payer entity.
	const counterpartyWalletId = await upsertCounterpartyWalletId(prisma, {
		caip2Network: requirements.network,
		address: verifyResponse.payer,
		role: X402CounterpartyRole.Payer,
	});
	const attempt = await prisma.x402PaymentAttempt.create({
		data: {
			direction: X402PaymentDirection.InboundVerify,
			status: verifyResponse.isValid ? X402PaymentStatus.Verified : X402PaymentStatus.Failed,
			apiKeyId,
			networkId: network.id,
			counterpartyWalletId,
			registryRequestId: source.registryRequestId,
			supportedPaymentSourceId,
			scheme: X402PaymentScheme.Exact,
			asset: requirements.asset,
			amount: BigInt(requirements.amount),
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
		include: {
			PaymentAttempt: {
				select: {
					id: true,
					supportedPaymentSourceId: true,
					networkId: true,
					Network: { select: { caip2Id: true } },
					CounterpartyWallet: { select: { address: true } },
				},
			},
		},
	});
	if (existingSettlement != null) {
		// Replay must be bound to the same registered source: the same on-chain
		// payment authorization (hence payload hash) settled for one source must not
		// return a fake success for a different source with identical economics.
		if (existingSettlement.PaymentAttempt.supportedPaymentSourceId !== supportedPaymentSourceId) {
			throw createHttpError(409, 'payment payload was already settled for a different registered resource');
		}
		const payerAddress = existingSettlement.PaymentAttempt.CounterpartyWallet?.address ?? null;
		const counterpartyWalletId = await upsertCounterpartyWalletId(prisma, {
			caip2Network: requirements.network,
			address: payerAddress,
			role: X402CounterpartyRole.Payer,
		});
		const replayAttempt = await prisma.x402PaymentAttempt.create({
			data: {
				direction: X402PaymentDirection.InboundSettle,
				status: X402PaymentStatus.Replayed,
				apiKeyId,
				// Reuse the original attempt's rail so replay history stays on the same chain.
				networkId: existingSettlement.PaymentAttempt.networkId,
				counterpartyWalletId,
				registryRequestId: source.registryRequestId,
				supportedPaymentSourceId,
				scheme: X402PaymentScheme.Exact,
				asset: requirements.asset,
				amount: BigInt(requirements.amount),
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
				network: existingSettlement.PaymentAttempt.Network.caip2Id as Network,
				amount: existingSettlement.amount?.toString(),
				payer: payerAddress ?? undefined,
			},
		};
	}

	// Validate/resolve the facilitator (retired / non-Selling → 400, or a remote facilitator)
	// BEFORE any settle-prep work, so a bad config is rejected without querying for or creating
	// a pre-settle attempt row. network.id pins the attempt's rail regardless of facilitator mode.
	const { facilitator, network } = await getFacilitatorForNetwork(requirements.network);

	// The crash-window guard, the durable pre-settle marker, and the on-chain settle all run UNDER
	// the per-facilitator lock (self-hosted; remote facilitators manage their own nonce → key is
	// null, no lock). Two reasons the lock must be taken BEFORE the marker is created:
	//   1. A lock-acquire timeout (facilitator saturated) then throws a clean 503 with NO attempt
	//      row, so the payload stays retryable — instead of leaving a stuck Verified marker that
	//      the crash-window guard would 409 on every future retry (a self-inflicted deadlock).
	//   2. Holding the guard under the lock makes a same-payload double-settle impossible at the
	//      app layer (the second waiter sees the first's marker), not merely rejected on-chain.
	//
	// Crash-window guard: a completed settlement was replayed above; a Verified pre-settle marker
	// (or a Settled attempt) with no settlement row means the previous settle crashed mid-flight or
	// is racing this one. Re-settling would revert on-chain (single-use nonce) and be recorded as a
	// FALSE failure — surface as needs-reconciliation.
	//
	// Marker rationale: written BEFORE the irreversible settle so a crash between settle and the
	// settlement write still blocks a re-settle on retry. evmWalletId = the network's facilitator
	// wallet (self-hosted) or null (remote); the counterparty (payer) is linked after settle below.
	//
	// Throw handling: the facilitator's ordinary failures RETURN {success:false} (handled below);
	// some paths THROW (pre-broadcast RPC failure, scheme mismatch, or a throw after submit). A
	// throw AFTER the marker was created is ambiguous (funds may have moved), so we record the
	// error and re-throw WITHOUT auto-failing — flipping to Failed could tell a charged buyer
	// "failed" and burn a consumed nonce on retry; that is an operator/reconciliation decision. A
	// throw BEFORE the marker (lock-timeout, or the 409 guard) leaves attemptId null → nothing to
	// record and the payload is cleanly retryable.
	let attemptId: string | null = null;
	let settleResponse: SettleResponse;
	try {
		settleResponse = await withFacilitatorSettleLock(network.facilitatorWalletId, async () => {
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
			const attempt = await prisma.x402PaymentAttempt.create({
				data: {
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Verified,
					apiKeyId,
					networkId: network.id,
					evmWalletId: network.facilitatorWalletId ?? null,
					registryRequestId: source.registryRequestId,
					supportedPaymentSourceId,
					scheme: X402PaymentScheme.Exact,
					asset: requirements.asset,
					amount: BigInt(requirements.amount),
					// Registered resource only; never persist the buyer-supplied payload resource.
					resource: source.resource,
					paymentPayloadHash,
					paymentPayload: encryptPaymentPayloadForStorage(paymentPayload),
					paymentIdentifier: identifier.id,
				},
				select: { id: true },
			});
			attemptId = attempt.id;
			return facilitator.settle(paymentPayload, requirements);
		});
	} catch (settleError) {
		// Only a throw AFTER the marker exists is ambiguous; a lock-timeout or the 409 guard throws
		// before creating it (attemptId still null) → nothing to record, clean retry.
		if (attemptId != null) {
			const errorMessage = settleError instanceof Error ? settleError.message : String(settleError);
			await prisma.x402PaymentAttempt
				.update({
					where: { id: attemptId },
					data: { errorReason: 'settle_threw', errorMessage },
				})
				.catch((recordError) => {
					logger.error('x402 settle threw AND recording the error on the attempt failed', {
						supportedPaymentSourceId,
						paymentPayloadHash,
						attemptId,
						recordError: recordError instanceof Error ? recordError.message : String(recordError),
					});
				});
			logger.error('x402 facilitator.settle threw; attempt left Verified for reconciliation', {
				supportedPaymentSourceId,
				paymentPayloadHash,
				attemptId,
				error: errorMessage,
			});
		}
		throw settleError;
	}

	// settleResponse is assigned only if the lambda ran to completion, which requires the marker to
	// have been created — so attemptId is non-null here; narrow it for the post-settle writes.
	if (attemptId == null) {
		throw createHttpError(500, 'x402 settle completed without a payment attempt');
	}
	const attemptIdForSettle: string = attemptId;

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
		// Link the buyer (payer) reported by the facilitator as the Payer counterparty.
		const counterpartyWalletId = await upsertCounterpartyWalletId(prisma, {
			caip2Network: requirements.network,
			address: settleResponse.payer,
			role: X402CounterpartyRole.Payer,
		});
		await prisma.x402PaymentAttempt.update({
			where: { id: attemptIdForSettle },
			data: {
				status: settleResponse.success ? X402PaymentStatus.Settled : X402PaymentStatus.Failed,
				...(counterpartyWalletId != null ? { counterpartyWalletId } : {}),
				errorReason: settleResponse.errorReason,
				errorMessage: settleResponse.errorMessage,
			},
		});

		if (settleResponse.success) {
			await writeSettlement({ attemptId: attemptIdForSettle, paymentPayloadHash, settleResponse });
		}
	} catch (writeError) {
		if (settleResponse.success) {
			logger.error('x402 settle SUCCEEDED but persisting the outcome failed; funds moved — needs reconciliation', {
				supportedPaymentSourceId,
				paymentPayloadHash,
				attemptId: attemptIdForSettle,
				txHash: settleResponse.transaction ?? null,
				error: writeError instanceof Error ? writeError.message : writeError,
			});
		}
		throw writeError;
	}

	return {
		attemptId: attemptIdForSettle,
		paymentPayloadHash,
		paymentIdentifier: identifier.id,
		replay: false,
		settleResponse,
		// Webhook-ready summary for the route handler to emit (settled or failed). Not part
		// of the HTTP response schema; the route strips it before responding.
		webhook: {
			attemptId: attemptIdForSettle,
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

	// The wallet is bound to exactly one payment source, so only a candidate on the wallet's
	// own (enabled) network can be signed. Resolve that binding once up front.
	const wallet = await getManagedWalletOrThrow(evmWalletId, X402EvmWalletType.Purchasing);
	const walletNetwork = await prisma.x402Network.findUnique({
		where: { id: wallet.networkId },
		select: { caip2Id: true, isEnabled: true },
	});
	if (walletNetwork == null || !walletNetwork.isEnabled) {
		throw createHttpError(400, 'The wallet network is not enabled');
	}

	// Select the first candidate on the wallet's network that has a funded budget for this
	// (apiKey, wallet, asset). Network scoping now comes from the wallet, not the budget row.
	let selectedRequirement: PaymentRequirements | null = null;
	for (const candidate of candidates) {
		if (candidate.network !== walletNetwork.caip2Id) continue;

		const budget = await prisma.x402WalletBudget.findFirst({
			where: {
				apiKeyId,
				evmWalletId,
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

	const { client, network, payer } = await getClientForWallet(evmWalletId, selected.network);

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

	const reservation = await reserveBudgetForAttempt({
		apiKeyId,
		evmWalletId,
		networkId: network.id,
		requirements: selected,
	});

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
