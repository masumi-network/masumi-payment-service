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
import { POSTGRES_BIGINT_MAX } from '@masumi/payment-core/payment-source';
import { readAssetAmount } from './balance';
import { getClientForWallet } from './facilitator';
import {
	assertWalletOwner,
	getManagedWalletOrThrow,
	normalizeAddress,
	upsertCounterpartyWalletId,
	X402_UNRESTRICTED,
	type X402OwnerScopeInput,
} from './internal';
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
	budgetGeneration,
	requirements,
	usageLimited,
}: {
	apiKeyId: string;
	evmWalletId: string;
	networkId: string;
	budgetId: string | null;
	budgetGeneration: number | null;
	requirements: PaymentRequirements;
	usageLimited: boolean;
}) {
	const amount = BigInt(requirements.amount);
	const asset = normalizeAddress(requirements.asset);
	const payTo = normalizeAddress(requirements.payTo);
	// Set only when the key's credit ledger is actually debited below, so the refund
	// path knows whether — and against which unit — to put the credits back.
	const creditUnit = usageLimited ? x402CreditUnit(requirements.network, requirements.asset) : null;
	const budgetAndAttempt = await prisma.$transaction(async (tx) => {
		if (budgetId != null) {
			if (budgetGeneration == null) throw createHttpError(500, 'x402 budget generation is missing');
			const updateResult = await tx.x402WalletBudget.updateMany({
				where: {
					id: budgetId,
					apiKeyId,
					evmWalletId,
					asset,
					generation: budgetGeneration,
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

		// The API key's own spending cap, the direct analogue of the Cardano purchase
		// path debiting RemainingUsageCredits. Independent of the wallet budget above:
		// the budget caps what one key may spend from one delegated wallet, this caps
		// what the key may spend in total. Opt-in — an unlimited key has usageLimited
		// false and never reaches here.
		//
		// Debited in the same transaction and guarded on the row still covering the
		// amount, so two concurrent payments cannot both pass the check and overspend.
		let creditRowId: string | null = null;
		if (creditUnit != null) {
			// Resolve the row first so the refund can be pinned to the exact row this
			// debited. Refunding by (apiKeyId, unit) alone would credit whatever row
			// carries that unit at refund time — including a replacement row created by
			// an admin credit reset — silently inflating the new balance.
			const creditRow = await tx.unitValue.findFirst({
				where: { apiKeyId, unit: creditUnit },
				select: { id: true },
			});
			const creditResult =
				creditRow == null
					? { count: 0 }
					: await tx.unitValue.updateMany({
							where: { id: creditRow.id, amount: { gte: amount } },
							data: { amount: { decrement: amount } },
						});
			if (creditResult.count !== 1) {
				throw createHttpError(
					402,
					`Insufficient usage credits for ${creditUnit}. This API key is usage limited; top up its credits for this chain and asset, or remove the limit.`,
				);
			}
			creditRowId = creditRow!.id;
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
				payTo,
			},
			select: { id: true },
		});

		return { apiKeyId, budgetId, budgetGeneration, creditUnit, creditRowId, attemptId: attempt.id, amount };
	});

	return budgetAndAttempt;
}

/**
 * Undo everything the reservation debited. Signing happens after the reservation
 * has committed, so a failure there leaves an attempt that is marked Failed with no
 * payment made — neither the wallet budget nor the key's usage credits may stay
 * debited for it.
 */
async function refundReservation(
	reservation: {
		apiKeyId: string;
		budgetId: string | null;
		budgetGeneration: number | null;
		creditUnit: string | null;
		creditRowId: string | null;
		amount: bigint;
	} | null,
) {
	if (reservation == null) return;
	await refundBudgetReservation(reservation);
	// The twin of the budget refund below: an unlimited key debited no credits, so
	// there is nothing to restore. Without this a signing failure would permanently
	// burn the key's credits for a payment that never happened, while the wallet
	// budget it was paying from was handed back.
	//
	// Pinned to the row the reservation actually debited, the credit-ledger analogue
	// of the budget refund's generation guard. Matching on (apiKeyId, unit) instead
	// would credit whichever row holds that unit now — so an admin credit reset
	// between debit and refund would inflate the replacement balance by an amount
	// that was never spent from it.
	if (reservation.creditRowId != null) {
		const result = await prisma.unitValue.updateMany({
			where: { id: reservation.creditRowId },
			data: { amount: { increment: reservation.amount } },
		});
		if (result.count !== 1) {
			logger.warn('x402 usage-credit refund skipped: debited credit row is gone (credits reset?)', {
				apiKeyId: reservation.apiKeyId,
				unit: reservation.creditUnit,
				creditRowId: reservation.creditRowId,
				amount: reservation.amount.toString(),
			});
		}
	}
}

async function refundBudgetReservation(
	reservation: { budgetId: string | null; budgetGeneration: number | null; amount: bigint } | null,
) {
	// The uncapped path debited no budget, so there is nothing to refund.
	if (reservation == null || reservation.budgetId == null || reservation.budgetGeneration == null) return;
	// Both generation and spentAmount must still reflect this reservation. A reset increments
	// generation and zeroes spentAmount, so an old refund cannot credit the replacement grant even
	// after newer reservations have raised its aggregate spentAmount again.
	const result = await prisma.x402WalletBudget.updateMany({
		where: {
			id: reservation.budgetId,
			generation: reservation.budgetGeneration,
			spentAmount: { gte: reservation.amount },
		},
		data: {
			remainingAmount: { increment: reservation.amount },
			spentAmount: { decrement: reservation.amount },
		},
	});
	if (result.count !== 1) {
		logger.warn('x402 budget refund skipped: reservation generation/spend no longer matches (budget reset?)', {
			budgetId: reservation.budgetId,
			budgetGeneration: reservation.budgetGeneration,
			amount: reservation.amount.toString(),
		});
	}
}

/**
 * Credit-ledger unit for an EVM asset. Chain-qualified because the same token
 * contract address exists on multiple chains, and a credit balance must not be
 * spendable across them. Mirrors the Cardano unit (policyId+assetName, '' for
 * lovelace); here the native gas token uses the literal 'native', matching the
 * low-balance rules.
 */
export function x402CreditUnit(caip2Network: string, asset: string): string {
	return `${caip2Network}:${normalizeAddress(asset)}`;
}

export async function createX402Payment({
	apiKeyId,
	caip2NetworkLimit,
	evmWalletId,
	paymentRequired,
	preferredNetwork,
	preferredAsset,
	paymentIdentifier,
	ownerScope = X402_UNRESTRICTED,
	usageLimited = false,
}: {
	apiKeyId: string;
	caip2NetworkLimit: string[] | null;
	evmWalletId: string;
	paymentRequired: PaymentRequired;
	preferredNetwork?: string;
	preferredAsset?: string;
	paymentIdentifier?: string;
	ownerScope?: X402OwnerScopeInput;
	/** Whether the calling key's spending is capped by its RemainingUsageCredits. */
	usageLimited?: boolean;
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
		if (!/^\d+$/.test(requirement.amount)) return false;
		const amount = BigInt(requirement.amount);
		if (amount <= 0n || amount > POSTGRES_BIGINT_MAX) return false;
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

	// Resolve public wallet metadata without applying owner scope or exposing type-specific errors.
	// A matching enabled budget is an explicit delegation from the wallet operator to another API
	// key; without ownership/admin access or such a grant, every foreign wallet remains a 404.
	const walletMetadata = await getManagedWalletOrThrow(evmWalletId);
	// Unrestricted (admin or unscoped key), the creator, or a key the wallet was
	// assigned to — otherwise access has to come from a budget grant below.
	const hasOwnerAccess =
		ownerScope.scope == null ||
		ownerScope.walletScopeIds == null ||
		walletMetadata.createdById === ownerScope.scope ||
		ownerScope.walletScopeIds.includes(evmWalletId);
	const budgetsByCandidate = new Map<
		PaymentRequirements,
		{ id: string; remainingAmount: bigint; generation: number }
	>();
	for (const candidate of candidates) {
		const budget = await prisma.x402WalletBudget.findFirst({
			where: {
				apiKeyId,
				evmWalletId,
				asset: normalizeAddress(candidate.asset),
				enabled: true,
			},
			select: { id: true, remainingAmount: true, generation: true },
		});
		if (budget != null) budgetsByCandidate.set(candidate, budget);
	}
	const hasMatchingBudgetGrant = budgetsByCandidate.size > 0;
	if (!hasOwnerAccess && !hasMatchingBudgetGrant) assertWalletOwner(ownerScope, walletMetadata);

	// Authorization is now established, so type validation can safely return a specific error.
	// Delegated access bypasses owner scope only after its matching grant has been found.
	const wallet = await getManagedWalletOrThrow(
		evmWalletId,
		X402EvmWalletType.Purchasing,
		hasOwnerAccess ? ownerScope : X402_UNRESTRICTED,
	);
	const walletNetwork = await prisma.x402Network.findUnique({
		where: { id: wallet.networkId },
		select: { caip2Id: true, isEnabled: true },
	});
	if (walletNetwork == null || !walletNetwork.isEnabled) {
		throw createHttpError(400, 'The wallet network is not enabled');
	}

	// Select the first candidate on the wallet's network. If a budget exists for (apiKey, wallet,
	// asset) it must cover the amount (capped path). If no budget exists and the caller owns the
	// wallet or is an admin, payment is uncapped at the node — the client (e.g. the SaaS) meters
	// spend itself and the on-chain balance is the real ceiling (checked below). An existing but
	// underfunded budget is a hard reject; it never falls through to uncapped spending.
	let selectedRequirement: PaymentRequirements | null = null;
	let selectedBudgetId: string | null = null;
	let selectedBudgetGeneration: number | null = null;
	for (const candidate of candidates) {
		if (candidate.network !== walletNetwork.caip2Id) continue;

		const budget = budgetsByCandidate.get(candidate);
		if (budget != null) {
			if (budget.remainingAmount < BigInt(candidate.amount)) continue;
			selectedRequirement = candidate;
			selectedBudgetId = budget.id;
			selectedBudgetGeneration = budget.generation;
			break;
		}
		if (hasOwnerAccess) {
			selectedRequirement = candidate;
			selectedBudgetId = null;
			selectedBudgetGeneration = null;
			break;
		}
	}
	if (selectedRequirement == null) {
		throw createHttpError(402, 'No managed wallet budget can cover the forwarded x402 payment requirements');
	}
	const selected = selectedRequirement;

	// A funded budget authorizes this caller to use the delegated wallet. The reservation below
	// rechecks the exact (apiKey, wallet, asset) grant and decrements it atomically before signing.
	const signingOwnerScope = selectedBudgetId != null ? X402_UNRESTRICTED : ownerScope;
	const { client, network, payer, publicClient } = await getClientForWallet(
		evmWalletId,
		selected.network,
		signingOwnerScope,
	);

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
		usageLimited,
		apiKeyId,
		evmWalletId,
		networkId: network.id,
		budgetId: selectedBudgetId,
		budgetGeneration: selectedBudgetGeneration,
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
		// reserved budget or credits; the status update is best-effort and must not mask
		// the error.
		await refundReservation(reservation);
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
