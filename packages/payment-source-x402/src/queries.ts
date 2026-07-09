import { Prisma, X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';
import { buildX402AttemptWhere } from './attempt-filters';

// Attempt projection for the dashboard. Network, payTo and payer are no longer stored on the
// attempt; they are reconstructed from the rail, the own wallet, the counterparty entity and
// (for inbound) the registered payment source — see mapAttempt below. paymentPayload and any
// encrypted material are never selected.
const ATTEMPT_SELECT = {
	id: true,
	createdAt: true,
	updatedAt: true,
	direction: true,
	status: true,
	apiKeyId: true,
	evmWalletId: true,
	registryRequestId: true,
	supportedPaymentSourceId: true,
	asset: true,
	amount: true,
	resource: true,
	paymentIdentifier: true,
	errorReason: true,
	errorMessage: true,
	Network: { select: { caip2Id: true } },
	EvmWallet: { select: { address: true } },
	CounterpartyWallet: { select: { address: true } },
	SupportedPaymentSource: { select: { payTo: true } },
	Settlement: {
		select: {
			id: true,
			success: true,
			txHash: true,
			amount: true,
			createdAt: true,
		},
	},
} satisfies Prisma.X402PaymentAttemptSelect;

type AttemptRow = Prisma.X402PaymentAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>;

// Reconstruct the legacy flat shape (caip2Network, payTo, payer) from the normalized model:
//   outbound → payer is the own wallet, payTo is the counterparty (Payee)
//   inbound  → payer is the counterparty (Payer), payTo is the registered source's payTo
// The settlement's payer mirrors the attempt payer (the buyer) for inbound settlements.
function mapAttempt(attempt: AttemptRow) {
	const { Network, EvmWallet, CounterpartyWallet, SupportedPaymentSource, Settlement, ...rest } = attempt;
	const isOutbound = attempt.direction === X402PaymentDirection.OutboundPayment;
	const counterparty = CounterpartyWallet?.address ?? null;
	const payer = isOutbound ? (EvmWallet?.address ?? null) : counterparty;
	const payTo = isOutbound ? counterparty : (SupportedPaymentSource?.payTo ?? null);
	return {
		...rest,
		caip2Network: Network.caip2Id,
		payTo,
		payer,
		Settlement: Settlement == null ? null : { ...Settlement, payer },
	};
}

export async function listX402PaymentAttempts(input: {
	take: number;
	cursorId?: string;
	status?: X402PaymentStatus;
	direction?: X402PaymentDirection;
	caip2Network?: string;
	filterNeedsManualAction?: boolean;
}) {
	const attempts = await prisma.x402PaymentAttempt.findMany({
		where: buildX402AttemptWhere(input),
		orderBy: { createdAt: 'desc' },
		take: input.take,
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		select: ATTEMPT_SELECT,
	});
	return attempts.map(mapAttempt);
}

const SETTLEMENT_SELECT = {
	id: true,
	createdAt: true,
	updatedAt: true,
	paymentAttemptId: true,
	success: true,
	txHash: true,
	amount: true,
	// Network + payer come from the linked attempt now; rawResponse is never projected.
	PaymentAttempt: {
		select: { Network: { select: { caip2Id: true } }, CounterpartyWallet: { select: { address: true } } },
	},
} satisfies Prisma.X402SettlementSelect;

type SettlementRow = Prisma.X402SettlementGetPayload<{ select: typeof SETTLEMENT_SELECT }>;

function mapSettlement(settlement: SettlementRow) {
	const { PaymentAttempt, ...rest } = settlement;
	return {
		...rest,
		caip2Network: PaymentAttempt.Network.caip2Id,
		payer: PaymentAttempt.CounterpartyWallet?.address ?? null,
	};
}

export async function listX402Settlements(input: { take: number; cursorId?: string; caip2Network?: string }) {
	const settlements = await prisma.x402Settlement.findMany({
		where: input.caip2Network != null ? { PaymentAttempt: { Network: { caip2Id: input.caip2Network } } } : undefined,
		orderBy: { createdAt: 'desc' },
		take: input.take,
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		select: SETTLEMENT_SELECT,
	});
	return settlements.map(mapSettlement);
}
