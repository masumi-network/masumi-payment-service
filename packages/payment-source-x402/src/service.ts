import createHttpError from 'http-errors';
import type { Network, PaymentPayload, SettleResponse } from '@x402/core/types';
import {
	X402CounterpartyRole,
	X402PaymentDirection,
	X402PaymentScheme,
	X402PaymentStatus,
	prisma,
} from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { isAllowedCaip2Network } from '@masumi/payment-core/network';
import { getFacilitatorForNetwork } from './facilitator';
import { upsertCounterpartyWalletId } from './internal';
import {
	encryptPaymentPayloadForStorage,
	getPaymentIdentifier,
	hashX402PaymentPayload,
	parseUintStringOrNull,
	toJsonValue,
} from './payload';
import { withFacilitatorSettleLock } from './settle-lock';
import {
	assertPayloadRequirementsMatchRegisteredSource,
	assertPaymentPayloadMatchesRegisteredResource,
	getX402SupportedPaymentSourceOrThrow,
	sourceToRequirements,
} from './requirements';

// Wallet CRUD lives in ./wallets; network/budget CRUD in ./networks; attempt/settlement list
// projections in ./queries; payload serialization in ./payload; the outbound-payment (buy) flow
// in ./pay. Re-exported so existing import sites (`@masumi/payment-source-x402`) and the service
// spec keep one entry point.
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
export { createX402Payment } from './pay';
export { hashX402PaymentPayload };

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
			// Only a rejected verify carries a reason; a remote facilitator (untrusted JSON) may
			// return isValid together with a non-null invalidReason, and persisting that onto a
			// Verified row would strand it in the needs-manual-action backlog.
			errorReason: verifyResponse.isValid ? null : verifyResponse.invalidReason,
			errorMessage: verifyResponse.isValid ? null : verifyResponse.invalidMessage,
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
					evmWalletId: true,
					counterpartyWalletId: true,
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
		// Reuse the original attempt's counterparty directly (it IS the (chain, payer, Payer)
		// row an upsert would resolve to) — same principle as reusing its networkId below.
		const counterpartyWalletId = existingSettlement.PaymentAttempt.counterpartyWalletId;
		const replayAttempt = await prisma.x402PaymentAttempt.create({
			data: {
				direction: X402PaymentDirection.InboundSettle,
				status: X402PaymentStatus.Replayed,
				apiKeyId,
				// Reuse the original attempt's rail so replay history stays on the same chain, and
				// its facilitator wallet so the replay is not misattributed to a remote facilitator.
				networkId: existingSettlement.PaymentAttempt.networkId,
				evmWalletId: existingSettlement.PaymentAttempt.evmWalletId,
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
