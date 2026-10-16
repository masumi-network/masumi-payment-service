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
	getManagedWalletOrThrow,
	normalizeAddress,
	upsertCounterpartyWalletId,
	X402_UNRESTRICTED,
	type X402OwnerScopeInput,
} from './internal';
import { encryptPaymentPayloadForStorage, getPaymentIdentifier, hashX402PaymentPayload } from './payload';
import { EXACT_SCHEME, requirementsMatch } from './requirements';

// Reserve the key's usage credits for an outbound payment and create the PaymentRequired
// attempt in one transaction. Network is structural (networkId, already validated to match
// the wallet's binding by the caller); the counterparty (payTo) is recorded as a Payee
// entity. The own wallet's address is not duplicated onto the row — it lives on EvmWallet.
async function reserveCreditsForAttempt({
	apiKeyId,
	evmWalletId,
	networkId,
	requirements,
	usageLimited,
}: {
	apiKeyId: string;
	evmWalletId: string;
	networkId: string;
	requirements: PaymentRequirements;
	usageLimited: boolean;
}) {
	const amount = BigInt(requirements.amount);
	const asset = normalizeAddress(requirements.asset);
	const payTo = normalizeAddress(requirements.payTo);
	// Set only when the key's credit ledger is actually debited below, so the refund
	// path knows whether — and against which unit — to put the credits back.
	const creditUnit = usageLimited ? x402CreditUnit(requirements.network, requirements.asset) : null;
	const creditAndAttempt = await prisma.$transaction(async (tx) => {
		// The API key's spending cap, the direct analogue of the Cardano purchase
		// path debiting RemainingUsageCredits — and, like Cardano, the ONLY node-side
		// cap: spend limits live on the key, never on the wallet (ADR 0016). Opt-in —
		// an unlimited key has usageLimited false and never reaches here.
		//
		// Debited in the same transaction and guarded on the row still covering the
		// amount, so two concurrent payments cannot both pass the check and overspend.
		let creditRowId: string | null = null;
		if (creditUnit != null) {
			// All rows for the unit, not findFirst: nothing enforces one row per
			// (apiKeyId, unit), so credits split across rows must be judged by their SUM
			// (as the Cardano path does) — checking one arbitrary row 402s payments the
			// key can actually afford, nondeterministically.
			const creditRows = await tx.unitValue.findMany({
				where: { apiKeyId, unit: creditUnit },
				orderBy: { id: 'asc' },
				select: { id: true, amount: true },
			});
			if (creditRows.length === 0) {
				// Fail closed. This used to grandfather a key with NO chain-qualified rows
				// to its pre-cap behaviour, on the grounds that usageLimited predates EVM
				// credits and once meant "Cardano-limited". That inverted what the flag
				// promises: a key the operator had marked limited spent x402 against the
				// wallet's whole balance, capped by nothing, and the only trace was a log
				// line nobody reads. No credits for the unit means no allowance, so the
				// payment is refused — the same answer the Cardano path gives.
				throw createHttpError(
					402,
					`Insufficient usage credits for ${creditUnit}. This API key is usage limited; top up its credits for this chain and asset, or remove the limit.`,
				);
			} else {
				// Consolidate split rows into the first one before debiting. Every write is
				// guarded on the amount read above, so a concurrent debit/refund/reset makes
				// the guard miss and the whole reservation rolls back as a retryable 409
				// instead of double-counting or losing an update.
				const target = creditRows[0];
				let targetAmount = target.amount;
				if (creditRows.length > 1) {
					for (const row of creditRows.slice(1)) {
						const merged = await tx.unitValue.deleteMany({ where: { id: row.id, amount: row.amount } });
						if (merged.count !== 1) {
							throw createHttpError(409, 'Usage credits changed concurrently; retry the payment');
						}
						targetAmount += row.amount;
					}
					const consolidated = await tx.unitValue.updateMany({
						where: { id: target.id, amount: target.amount },
						data: { amount: targetAmount },
					});
					if (consolidated.count !== 1) {
						throw createHttpError(409, 'Usage credits changed concurrently; retry the payment');
					}
				}
				// Guarded on the consolidated row still covering the amount, so two
				// concurrent payments cannot both pass the check and overspend. The row id
				// is kept so the refund is pinned to the exact row this debited — refunding
				// by (apiKeyId, unit) would credit whatever row carries the unit at refund
				// time, including a replacement created by an admin credit reset.
				const creditResult = await tx.unitValue.updateMany({
					where: { id: target.id, amount: { gte: amount } },
					data: { amount: { decrement: amount } },
				});
				if (creditResult.count !== 1) {
					// A miss means either "the balance is short" (402, terminal — the caller
					// must top up) or "the row changed under us" (409, retryable). Reporting
					// the second as 402 tells a fully funded caller its payment was declined
					// for lack of funds, and agents treat 402 as terminal, so distinguish
					// them by re-reading the row inside this still-open transaction.
					const stillThere = await tx.unitValue.findFirst({ where: { id: target.id }, select: { id: true } });
					if (stillThere == null) {
						throw createHttpError(409, 'Usage credits changed concurrently; retry the payment');
					}
					throw createHttpError(
						402,
						`Insufficient usage credits for ${creditUnit}. This API key is usage limited; top up its credits for this chain and asset, or remove the limit.`,
					);
				}
				creditRowId = target.id;
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
				payTo,
			},
			select: { id: true },
		});

		return { apiKeyId, creditUnit, creditRowId, attemptId: attempt.id, amount };
	});

	return creditAndAttempt;
}

/**
 * Undo what the reservation debited. Signing happens after the reservation has
 * committed, so a failure there leaves an attempt that is marked Failed with no
 * payment made — the key's usage credits may not stay debited for it.
 */
async function refundReservation(
	reservation: {
		apiKeyId: string;
		creditUnit: string | null;
		creditRowId: string | null;
		amount: bigint;
	} | null,
) {
	if (reservation == null) return;
	// An unlimited key debited no credits, so there is nothing to restore. Without
	// this a signing failure would permanently burn the key's credits for a payment
	// that never happened.
	//
	// May not throw out of here: a propagated error would skip the caller's
	// Failed-status update and replace the original signing error with a transient
	// DB one — leaving the attempt open AND the ledger debited with no trace.
	// Failures are logged with full context for manual reconciliation instead.
	//
	// Pinned to the row the reservation actually debited. Matching on
	// (apiKeyId, unit) instead would credit whichever row holds that unit now — so
	// an admin credit reset between debit and refund would inflate the replacement
	// balance by an amount that was never spent from it.
	if (reservation.creditRowId != null && reservation.creditUnit != null) {
		try {
			const result = await prisma.unitValue.updateMany({
				where: { id: reservation.creditRowId },
				data: { amount: { increment: reservation.amount } },
			});
			if (result.count !== 1) {
				// The pinned row is gone. Credit the key's current row for the same unit
				// instead of dropping the refund: the debit really did reduce this key's
				// balance for this unit, so the amount is owed to it wherever that balance
				// now lives (a Cardano purchase consolidating duplicates, or an admin
				// rewriting the unit, can retire the id). Scoped to (apiKeyId, unit) so it
				// can never credit another key or another asset.
				//
				// Resolved to ONE row id first. Incrementing on (apiKeyId, unit) directly
				// would credit EVERY row for that unit, and the ledger permits duplicates
				// (which is why the reservation above consolidates them), so a two-row unit
				// would be refunded twice — silently widening the only spend cap this key
				// has. The count check below cannot undo that: the write already landed.
				const replacement = await prisma.unitValue.findFirst({
					where: { apiKeyId: reservation.apiKeyId, unit: reservation.creditUnit },
					orderBy: { id: 'asc' },
					select: { id: true },
				});
				const fallback = replacement
					? await prisma.unitValue.updateMany({
							where: { id: replacement.id },
							data: { amount: { increment: reservation.amount } },
						})
					: { count: 0 };
				if (fallback.count === 1) {
					logger.warn('x402 usage-credit refund fell back to the current row for the unit (debited row retired)', {
						apiKeyId: '[REDACTED]',
						unit: reservation.creditUnit,
						creditRowId: reservation.creditRowId,
						amount: reservation.amount.toString(),
					});
				} else {
					logger.error('x402 usage-credit refund failed: no row for the debited unit — needs reconciliation', {
						apiKeyId: '[REDACTED]',
						unit: reservation.creditUnit,
						creditRowId: reservation.creditRowId,
						matchedRows: fallback.count,
						amount: reservation.amount.toString(),
					});
				}
			}
		} catch (error) {
			logger.error('x402 usage-credit refund threw; credits remain debited — needs manual reconciliation', {
				apiKeyId: '[REDACTED]',
				unit: reservation.creditUnit,
				creditRowId: reservation.creditRowId,
				amount: reservation.amount.toString(),
				error,
			});
		}
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
	usageLimited,
}: {
	apiKeyId: string;
	caip2NetworkLimit: string[] | null;
	evmWalletId: string;
	paymentRequired: PaymentRequired;
	preferredNetwork?: string;
	preferredAsset?: string;
	paymentIdentifier?: string;
	ownerScope?: X402OwnerScopeInput;
	/**
	 * Whether the calling key's spending is capped by its RemainingUsageCredits.
	 * REQUIRED, not defaulted: this gates a spending control, and an optional
	 * `false` default meant any future caller that forgot it would silently pay
	 * uncapped with nothing in the type system or the logs to flag it.
	 */
	usageLimited: boolean;
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
		// reaches BigInt()/credit math. A negative value would invert the credit
		// decrement (minting credits); a non-numeric value would throw.
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

	// Wallet access is ownership or assignment ONLY (the Cardano model, ADR 0016):
	// admin/unscoped keys, the wallet's creator, or a key the wallet was assigned to
	// via its scope list. The owner check runs before the type check, so every
	// inaccessible wallet is a 404 (a scoped key cannot probe foreign wallet types)
	// while a wrong-type wallet the caller CAN access is a specific 400.
	const wallet = await getManagedWalletOrThrow(evmWalletId, X402EvmWalletType.Purchasing, ownerScope);
	const walletNetwork = await prisma.x402Network.findUnique({
		where: { id: wallet.networkId },
		select: { caip2Id: true, isEnabled: true },
	});
	if (walletNetwork == null || !walletNetwork.isEnabled) {
		throw createHttpError(400, 'The wallet network is not enabled');
	}

	// Select the first candidate on the wallet's network. Wallet access grants spend
	// (assignment deliberately inherits own-wallet semantics — Cardano parity): the ceilings
	// are the key's usage credits (when usageLimited, reserved below) and the wallet's
	// on-chain balance (checked below). There is no per-wallet cap (ADR 0016).
	const selected = candidates.find((candidate) => candidate.network === walletNetwork.caip2Id) ?? null;
	if (selected == null) {
		// 400, not 402: the forwarded 402 simply offers no requirement this wallet's chain can
		// pay, which is the same class of mismatch as the key-limit check above. Reserve 402 for
		// "the balance is short", which agents treat as terminal-and-top-up-able.
		throw createHttpError(400, 'No forwarded x402 payment requirement matches the managed wallet network');
	}

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

	// Pin the client to the single requirement we selected and reserved for, so the
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

	const reservation = await reserveCreditsForAttempt({
		usageLimited,
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
		// reserved credits; the status update is best-effort and must not mask
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
