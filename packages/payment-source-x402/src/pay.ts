import createHttpError from 'http-errors';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { appendPaymentIdentifierToExtensions, PAYMENT_IDENTIFIER } from '@x402/extensions/payment-identifier';
import {
	X402CounterpartyRole,
	X402EvmWalletType,
	X402PaymentDirection,
	X402PaymentScheme,
	X402PaymentStatus,
	prisma,
} from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { isAllowedCaip2Network } from '@masumi/payment-core/network';
import { readAssetAmount } from './balance';
import { getClientForWallet } from './facilitator';
import { getManagedWalletOrThrow, normalizeAddress, upsertCounterpartyWalletId, type X402OwnerScope } from './internal';
import { encryptPaymentPayloadForStorage, getPaymentIdentifier, hashX402PaymentPayload } from './payload';
import { EXACT_SCHEME, requirementsMatch } from './requirements';

// Reserve budget for an outbound payment and create the PaymentRequired attempt in one
// transaction. Network is structural (networkId, already validated to match the wallet's
// binding by the caller); the counterparty (payTo) is recorded as a Payee entity. The own
// wallet's address is not duplicated onto the row — it lives on EvmWallet.
//
// budgetId is the budget selected by createX402Payment, or null for the uncapped path (a
// self-owned wallet with no configured budget — see the selection loop below). The capped path
// debits the budget atomically, guarded on it still covering the amount; the uncapped path
// touches no budget row.
async function reserveBudgetForAttempt({
	apiKeyId,
	evmWalletId,
	networkId,
	budgetId,
	requirements,
}: {
	apiKeyId: string;
	evmWalletId: string;
	networkId: string;
	budgetId: string | null;
	requirements: PaymentRequirements;
}) {
	const amount = BigInt(requirements.amount);
	const asset = normalizeAddress(requirements.asset);
	const payTo = normalizeAddress(requirements.payTo);
	const budgetAndAttempt = await prisma.$transaction(async (tx) => {
		if (budgetId != null) {
			const updateResult = await tx.x402WalletBudget.updateMany({
				where: {
					id: budgetId,
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

		return { budgetId, attemptId: attempt.id, amount };
	});

	return budgetAndAttempt;
}

async function refundBudgetReservation(reservation: { budgetId: string | null; amount: bigint } | null) {
	// The uncapped path debited no budget, so there is nothing to refund.
	if (reservation == null || reservation.budgetId == null) return;
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

export async function createX402Payment({
	apiKeyId,
	caip2NetworkLimit,
	evmWalletId,
	paymentRequired,
	preferredNetwork,
	preferredAsset,
	paymentIdentifier,
	ownerScope = null,
}: {
	apiKeyId: string;
	caip2NetworkLimit: string[] | null;
	evmWalletId: string;
	paymentRequired: PaymentRequired;
	preferredNetwork?: string;
	preferredAsset?: string;
	paymentIdentifier?: string;
	ownerScope?: X402OwnerScope;
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
	// own (enabled) network can be signed. ownerScope enforces tenant isolation: a scoped caller
	// may only spend a wallet it created. Resolve the binding + ownership once up front.
	const wallet = await getManagedWalletOrThrow(evmWalletId, X402EvmWalletType.Purchasing, ownerScope);
	const walletNetwork = await prisma.x402Network.findUnique({
		where: { id: wallet.networkId },
		select: { caip2Id: true, isEnabled: true },
	});
	if (walletNetwork == null || !walletNetwork.isEnabled) {
		throw createHttpError(400, 'The wallet network is not enabled');
	}

	// Select the first candidate on the wallet's network. If a budget exists for (apiKey, wallet,
	// asset) it must cover the amount (capped path). If no budget exists and the caller owns the
	// wallet, the payment is uncapped at the node — the client (e.g. the SaaS) meters spend itself
	// and the on-chain balance is the real ceiling (checked below). A budget that exists but is
	// underfunded is a hard reject; we never fall through to the uncapped path for a wallet the
	// caller does not own.
	const selfOwned = wallet.createdById === apiKeyId;
	let selectedRequirement: PaymentRequirements | null = null;
	let selectedBudgetId: string | null = null;
	for (const candidate of candidates) {
		if (candidate.network !== walletNetwork.caip2Id) continue;

		const budget = await prisma.x402WalletBudget.findFirst({
			where: {
				apiKeyId,
				evmWalletId,
				asset: normalizeAddress(candidate.asset),
				enabled: true,
			},
			select: { id: true, remainingAmount: true },
		});
		if (budget != null) {
			if (budget.remainingAmount < BigInt(candidate.amount)) continue;
			selectedRequirement = candidate;
			selectedBudgetId = budget.id;
			break;
		}
		if (selfOwned) {
			selectedRequirement = candidate;
			selectedBudgetId = null;
			break;
		}
	}
	if (selectedRequirement == null) {
		throw createHttpError(402, 'No managed wallet budget can cover the forwarded x402 payment requirements');
	}
	const selected = selectedRequirement;

	const { client, network, payer, publicClient } = await getClientForWallet(evmWalletId, selected.network, ownerScope);

	// The real spend ceiling for a node-custodial wallet is its on-chain balance, so reject early
	// when the wallet cannot cover the transfer (the authorization would otherwise fail at settle).
	// A failed RPC read is non-fatal — settle re-verifies on-chain — so a flaky endpoint does not
	// block an otherwise-fundable payment.
	try {
		const onChainBalance = await readAssetAmount(publicClient, payer, normalizeAddress(selected.asset));
		if (onChainBalance < BigInt(selected.amount)) {
			throw createHttpError(402, 'Managed wallet has insufficient on-chain balance for this payment');
		}
	} catch (error) {
		if (createHttpError.isHttpError(error)) throw error;
		logger.warn('x402 on-chain balance pre-check failed; proceeding (settle re-verifies on-chain)', {
			evmWalletId,
			caip2Network: selected.network,
			error,
		});
	}

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
		budgetId: selectedBudgetId,
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
