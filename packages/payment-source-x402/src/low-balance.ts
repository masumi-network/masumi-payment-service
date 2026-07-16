import createHttpError from 'http-errors';
import { LowBalanceStatus, Prisma, X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { assertHexAddress, assertRpcServesDeclaredChain, normalizeAddress } from './internal';
import { NATIVE_ASSET, buildPublicClient, readAssetAmount } from './balance';
import type { HexAddress } from './internal';

const RULE_SELECT = {
	id: true,
	evmWalletId: true,
	// The rule's chain is implied by its wallet's bound network; project it for output.
	EvmWallet: { select: { address: true, Network: { select: { caip2Id: true } } } },
	asset: true,
	thresholdAmount: true,
	enabled: true,
	status: true,
	lastKnownAmount: true,
	lastCheckedAt: true,
	lastAlertedAt: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.X402EvmWalletLowBalanceRuleSelect;

type RuleRow = Prisma.X402EvmWalletLowBalanceRuleGetPayload<{ select: typeof RULE_SELECT }>;

// Preserve the previous wire shape (flat caip2Network + EvmWallet.address) even though the
// rule no longer stores the chain — it is resolved through the wallet's network.
function flattenRule(rule: RuleRow) {
	const { EvmWallet, ...rest } = rule;
	return { ...rest, caip2Network: EvmWallet.Network.caip2Id, EvmWallet: { address: EvmWallet.address } };
}

// A balance is Low when it is strictly below the configured threshold. Pure so the
// transition logic stays unit-testable without RPC or DB.
export function computeLowBalanceStatus(amount: bigint, threshold: bigint): LowBalanceStatus {
	return amount < threshold ? LowBalanceStatus.Low : LowBalanceStatus.Healthy;
}

// Normalize the asset id: an ERC-20 contract is lowercased and validated; the native gas
// token is the literal "native".
function normalizeRuleAsset(asset: string): string {
	if (asset === NATIVE_ASSET) return NATIVE_ASSET;
	assertHexAddress(asset, 'asset');
	return normalizeAddress(asset);
}

export async function setX402LowBalanceRule(input: {
	evmWalletId: string;
	// Optional now: the rule inherits the wallet's bound network. When supplied it must match,
	// so a caller cannot arm a rule against a chain the wallet does not operate on.
	caip2Network?: string;
	asset: string;
	thresholdAmount: string;
	enabled?: boolean;
}) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: input.evmWalletId, deletedAt: null },
		select: { id: true, Network: { select: { caip2Id: true } } },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	if (input.caip2Network != null && input.caip2Network !== wallet.Network.caip2Id) {
		throw createHttpError(400, 'caip2Network does not match the wallet network');
	}
	const asset = normalizeRuleAsset(input.asset);
	const thresholdAmount = BigInt(input.thresholdAmount);
	if (thresholdAmount < 0n) {
		throw createHttpError(400, 'thresholdAmount must not be negative');
	}

	const rule = await prisma.x402EvmWalletLowBalanceRule.upsert({
		where: {
			evmWalletId_asset: {
				evmWalletId: input.evmWalletId,
				asset,
			},
		},
		create: {
			evmWalletId: input.evmWalletId,
			asset,
			thresholdAmount,
			enabled: input.enabled ?? true,
		},
		// Re-arming the threshold resets the state machine so the next check re-evaluates
		// and can re-alert.
		update: {
			thresholdAmount,
			enabled: input.enabled ?? undefined,
			status: LowBalanceStatus.Unknown,
		},
		select: RULE_SELECT,
	});
	return flattenRule(rule);
}

export async function listX402LowBalanceRules(input?: {
	evmWalletId?: string;
	onlyLow?: boolean;
	includeDisabled?: boolean;
}) {
	const rules = await prisma.x402EvmWalletLowBalanceRule.findMany({
		where: {
			evmWalletId: input?.evmWalletId,
			enabled: input?.includeDisabled ? undefined : true,
			status: input?.onlyLow ? LowBalanceStatus.Low : undefined,
		},
		orderBy: { createdAt: 'desc' },
		select: RULE_SELECT,
	});
	return rules.map(flattenRule);
}

export async function updateX402LowBalanceRule(input: { ruleId: string; thresholdAmount?: string; enabled?: boolean }) {
	const existing = await prisma.x402EvmWalletLowBalanceRule.findUnique({
		where: { id: input.ruleId },
		select: { id: true },
	});
	if (existing == null) {
		throw createHttpError(404, 'x402 low-balance rule not found');
	}
	const thresholdAmount = input.thresholdAmount != null ? BigInt(input.thresholdAmount) : undefined;
	if (thresholdAmount != null && thresholdAmount < 0n) {
		throw createHttpError(400, 'thresholdAmount must not be negative');
	}
	const rule = await prisma.x402EvmWalletLowBalanceRule.update({
		where: { id: input.ruleId },
		data: {
			thresholdAmount,
			enabled: input.enabled,
			// Re-arm the state machine only when the threshold actually moves, so the next
			// cycle re-evaluates against the new bar. An enabled-only toggle must NOT reset
			// status, otherwise a still-Low wallet would re-fire its alert on every toggle.
			...(thresholdAmount != null ? { status: LowBalanceStatus.Unknown } : {}),
		},
		select: RULE_SELECT,
	});
	return flattenRule(rule);
}

export async function deleteX402LowBalanceRule(ruleId: string) {
	const existing = await prisma.x402EvmWalletLowBalanceRule.findUnique({
		where: { id: ruleId },
		select: { id: true },
	});
	if (existing == null) {
		throw createHttpError(404, 'x402 low-balance rule not found');
	}
	await prisma.x402EvmWalletLowBalanceRule.delete({ where: { id: ruleId } });
	return { ruleId, deletedAt: new Date() };
}

export type X402LowBalanceAlert = {
	ruleId: string;
	evmWalletId: string;
	walletAddress: string;
	walletType: X402EvmWalletType;
	caip2Network: string;
	asset: string;
	thresholdAmount: string;
	currentAmount: string;
	checkedAt: string;
};

/**
 * Evaluates every enabled low-balance rule against live on-chain balances, advances each
 * rule's state machine (Unknown/Healthy ⇄ Low), and returns the alerts for rules that just
 * transitioned INTO Low. The caller (the scheduled job) is responsible for emitting webhooks
 * for the returned alerts, keeping this package free of app-level webhook dependencies.
 */
export async function evaluateX402LowBalanceRules(): Promise<X402LowBalanceAlert[]> {
	const rules = await prisma.x402EvmWalletLowBalanceRule.findMany({
		where: { enabled: true, EvmWallet: { deletedAt: null } },
		select: {
			id: true,
			asset: true,
			thresholdAmount: true,
			status: true,
			// The rule's chain is the wallet's bound network.
			EvmWallet: { select: { id: true, address: true, type: true, Network: { select: { caip2Id: true } } } },
		},
	});
	if (rules.length === 0) return [];

	// Build one RPC client per distinct network referenced by the rules' wallets.
	const networks = await prisma.x402Network.findMany({
		where: {
			isEnabled: true,
			caip2Id: { in: Array.from(new Set(rules.map((r) => r.EvmWallet.Network.caip2Id))) },
		},
		select: { caip2Id: true, rpcUrl: true, displayName: true },
	});
	const networkById = new Map(networks.map((n) => [n.caip2Id, n]));

	const checkedAt = new Date();
	const alerts: X402LowBalanceAlert[] = [];

	for (const rule of rules) {
		const caip2Network = rule.EvmWallet.Network.caip2Id;
		const network = networkById.get(caip2Network);
		if (network == null) continue; // network disabled/removed since the rule was set
		try {
			const client = buildPublicClient(network);
			// Verify the RPC serves the chain it claims before trusting its balance, so a
			// misconfigured RPC cannot raise (or suppress) alerts off the wrong chain.
			await assertRpcServesDeclaredChain(client, caip2Network);
			const amount = await readAssetAmount(client, rule.EvmWallet.address as HexAddress, rule.asset);
			const nextStatus = computeLowBalanceStatus(amount, rule.thresholdAmount);
			const transitionedToLow = nextStatus === LowBalanceStatus.Low && rule.status !== LowBalanceStatus.Low;

			await prisma.x402EvmWalletLowBalanceRule.update({
				where: { id: rule.id },
				data: {
					status: nextStatus,
					lastKnownAmount: amount,
					lastCheckedAt: checkedAt,
					...(transitionedToLow ? { lastAlertedAt: checkedAt } : {}),
				},
			});

			if (transitionedToLow) {
				alerts.push({
					ruleId: rule.id,
					evmWalletId: rule.EvmWallet.id,
					walletAddress: rule.EvmWallet.address,
					walletType: rule.EvmWallet.type,
					caip2Network,
					asset: rule.asset,
					thresholdAmount: rule.thresholdAmount.toString(),
					currentAmount: amount.toString(),
					checkedAt: checkedAt.toISOString(),
				});
			}
		} catch (error) {
			// A single unreachable RPC or non-compliant token must not abort the whole cycle.
			logger.warn('x402 low-balance check failed for a rule', { ruleId: rule.id, error });
		}
	}

	return alerts;
}
