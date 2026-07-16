import { Prisma, X402FacilitatorMode, X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';
import { buildX402AttemptWhere } from './attempt-filters';
import { getX402DatabaseNow } from './settle-lock';

// Attempt projection for the dashboard. Network and payer are reconstructed from the rail and
// wallet relations. payTo is retained as an immutable snapshot so inbound history survives
// registered-source replacement; nullable transition rows fall back to their relation below.
// paymentPayload and any encrypted material are never selected.
const ATTEMPT_SELECT = {
	id: true,
	createdAt: true,
	updatedAt: true,
	direction: true,
	status: true,
	apiKeyId: true,
	evmWalletId: true,
	facilitatorMode: true,
	registryRequestId: true,
	supportedPaymentSourceId: true,
	asset: true,
	amount: true,
	payTo: true,
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
//   outbound → payer is the own wallet; null snapshot falls back to the Payee counterparty
//   inbound  → payer is the Payer counterparty; null snapshot falls back to the live source
// The settlement's payer mirrors the attempt payer (the buyer) for inbound settlements.
function mapAttempt(attempt: AttemptRow) {
	const { Network, EvmWallet, CounterpartyWallet, SupportedPaymentSource, Settlement, facilitatorMode, ...rest } =
		attempt;
	const isOutbound = attempt.direction === X402PaymentDirection.OutboundPayment;
	const counterparty = CounterpartyWallet?.address ?? null;
	const payer = isOutbound ? (EvmWallet?.address ?? null) : counterparty;
	const payTo = attempt.payTo ?? (isOutbound ? counterparty : (SupportedPaymentSource?.payTo ?? null));
	// Which facilitator settled this: new inbound attempts snapshot the mode at execution time.
	// Legacy rows deliberately keep a null snapshot because today's network/wallet assignment
	// cannot prove which facilitator handled a historical payment.
	const facilitator =
		attempt.direction === X402PaymentDirection.InboundSettle
			? facilitatorMode === X402FacilitatorMode.SelfHosted
				? { mode: 'self_hosted' as const, address: EvmWallet?.address ?? null }
				: facilitatorMode === X402FacilitatorMode.Remote
					? { mode: 'remote' as const, address: null }
					: { mode: 'unknown' as const, address: null }
			: null;
	return {
		...rest,
		caip2Network: Network.caip2Id,
		payTo,
		payer,
		facilitator,
		Settlement: Settlement == null ? null : { ...Settlement, payer },
	};
}

export async function listX402PaymentAttempts(input: {
	take: number;
	cursorId?: string;
	status?: X402PaymentStatus;
	direction?: X402PaymentDirection;
	side?: 'buy' | 'sell';
	caip2Network?: string;
	filterNeedsManualAction?: boolean;
	// Tenant scope: restricts to attempts initiated by this API key (undefined = all).
	apiKeyId?: string;
}) {
	const databaseNow = input.filterNeedsManualAction === true ? await getX402DatabaseNow() : undefined;
	const attempts = await prisma.x402PaymentAttempt.findMany({
		where: buildX402AttemptWhere(input, databaseNow),
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

export async function listX402Settlements(input: {
	take: number;
	cursorId?: string;
	caip2Network?: string;
	// Tenant scope: restricts to settlements whose attempt was initiated by this API key.
	apiKeyId?: string;
}) {
	// Network + tenant scope both live on the linked attempt, not a settlement column.
	const paymentAttemptFilter: Prisma.X402PaymentAttemptWhereInput = {
		...(input.apiKeyId != null ? { apiKeyId: input.apiKeyId } : {}),
		...(input.caip2Network != null ? { Network: { caip2Id: input.caip2Network } } : {}),
	};
	const settlements = await prisma.x402Settlement.findMany({
		where: Object.keys(paymentAttemptFilter).length > 0 ? { PaymentAttempt: paymentAttemptFilter } : undefined,
		orderBy: { createdAt: 'desc' },
		take: input.take,
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		select: SETTLEMENT_SELECT,
	});
	return settlements.map(mapSettlement);
}
