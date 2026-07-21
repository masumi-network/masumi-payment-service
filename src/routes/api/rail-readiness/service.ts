import { Network } from '@/generated/prisma/client';
import { classifyV2SourceSync } from '@/utils/v2-contract-sync';
import { RAIL_READINESS_CHECK_IDS } from './schemas';

type CheckId = (typeof RAIL_READINESS_CHECK_IDS)[number];

export type RailReadinessCheck = {
	id: CheckId;
	label: string;
	isComplete: boolean;
	detail: string | null;
};

export type RailReadiness = {
	rail: 'CardanoV2' | 'X402';
	isReady: boolean;
	Checks: RailReadinessCheck[];
};

/** Plain shapes so the rules stay unit-testable without a database. */
export type CardanoReadinessInput = {
	network: Network;
	sources: Array<{
		policyId: string | null;
		smartContractAddress: string;
		requiredAdminSignatures: number | null;
		disablePaymentAt: Date | null;
		adminWalletCount: number;
		rpcProviderApiKey: string | null;
		sellingWalletCount: number;
		purchasingWalletCount: number;
	}>;
};

export type X402ReadinessInput = {
	chains: Array<{
		caip2Id: string;
		isEnabled: boolean;
		rpcUrl: string | null;
		facilitatorWalletId: string | null;
		facilitatorUrl: string | null;
		sellingWalletCount: number;
		purchasingWalletCount: number;
		fundedBudgetCount: number;
	}>;
};

function check(id: CheckId, label: string, isComplete: boolean, detail: string | null = null): RailReadinessCheck {
	return { id, label, isComplete, detail };
}

/**
 * Cardano V2 readiness.
 *
 * Evaluated per source and then rolled up optimistically: if ANY single V2
 * source in the environment satisfies every blocking check, the rail is ready.
 * A half-configured second source must not un-ready a working one — operators
 * routinely keep an old source around alongside the one actually in use.
 *
 * The reported checks belong to the best candidate (most checks passed), so a
 * partially configured setup shows the shortest real path to done rather than
 * an arbitrary source's failures.
 */
export function evaluateCardanoReadiness(input: CardanoReadinessInput): RailReadiness {
	if (input.sources.length === 0) {
		return {
			rail: 'CardanoV2',
			isReady: false,
			Checks: [
				check(
					'cardano.payment_source',
					'Payment source',
					false,
					'No active Web3CardanoV2 payment source exists for this network',
				),
				check('cardano.contract_current', 'Current contract', false, 'Needs a payment source first'),
				check('cardano.rpc_provider', 'Blockfrost API key', false, 'Needs a payment source first'),
				check('cardano.admin_signatures', 'Admin wallets', false, 'Needs a payment source first'),
				check('cardano.selling_wallet', 'Selling wallet', false, 'Needs a payment source first'),
				check('cardano.purchasing_wallet', 'Purchasing wallet', false, 'Needs a payment source first'),
				check('cardano.payments_enabled', 'Payments enabled', false, 'Needs a payment source first'),
			],
		};
	}

	const evaluated = input.sources.map((source) => {
		const syncStatus = classifyV2SourceSync({
			network: input.network,
			policyId: source.policyId,
			smartContractAddress: source.smartContractAddress,
		});
		// `custom_address` is a legitimate non-default deployment, not a fault —
		// only a retired policy id blocks the rail.
		const contractCurrent = syncStatus !== 'outdated_contract';
		// V2 sources carry a signature threshold; treat a missing value as 1 so a
		// malformed row fails the check rather than passing vacuously.
		const requiredSignatures = source.requiredAdminSignatures ?? 1;
		const hasSignatures = source.adminWalletCount >= requiredSignatures;
		const hasRpcKey = (source.rpcProviderApiKey ?? '').trim().length > 0;
		const paymentsEnabled = source.disablePaymentAt === null;

		const checks: RailReadinessCheck[] = [
			check('cardano.payment_source', 'Payment source', true, 'Active Web3CardanoV2 source found'),
			check(
				'cardano.contract_current',
				'Current contract',
				contractCurrent,
				contractCurrent
					? syncStatus === 'custom_address'
						? 'Custom contract address on the current contract version'
						: null
					: 'Source was minted against a retired contract and must be recreated',
			),
			check(
				'cardano.rpc_provider',
				'Blockfrost API key',
				hasRpcKey,
				hasRpcKey ? null : 'No RPC provider key configured',
			),
			check(
				'cardano.admin_signatures',
				'Admin wallets',
				hasSignatures,
				hasSignatures
					? null
					: `${source.adminWalletCount} admin wallet(s) configured but ${requiredSignatures} signature(s) required`,
			),
			check(
				'cardano.selling_wallet',
				'Selling wallet',
				source.sellingWalletCount > 0,
				source.sellingWalletCount > 0 ? null : 'No selling wallet — the source cannot receive payments',
			),
			check(
				'cardano.purchasing_wallet',
				'Purchasing wallet',
				source.purchasingWalletCount > 0,
				source.purchasingWalletCount > 0 ? null : 'No purchasing wallet — the source cannot pay other agents',
			),
			check(
				'cardano.payments_enabled',
				'Payments enabled',
				paymentsEnabled,
				paymentsEnabled ? null : 'Payments are administratively disabled on this source',
			),
		];

		return { checks, passed: checks.filter((entry) => entry.isComplete).length };
	});

	// A source is ready only if every check passes; selling and purchasing are
	// both required because a Cardano source is expected to trade in both
	// directions (unlike x402, where paying is genuinely optional).
	const readySource = evaluated.find((entry) => entry.checks.every((c) => c.isComplete));
	const best = readySource ?? evaluated.reduce((a, b) => (b.passed > a.passed ? b : a));

	return { rail: 'CardanoV2', isReady: readySource !== undefined, Checks: best.checks };
}

/**
 * x402 (EVM) readiness.
 *
 * The substantive check here is the facilitator MODE, not its presence. Both
 * `canSettle` and the wizard ask `facilitatorWalletId || facilitatorUrl`, but
 * `getFacilitatorForNetwork` throws when BOTH are set, so a both-set row reads
 * as configured everywhere and then fails at settle time. Writes already reject
 * that combination, so this only catches a legacy or hand-edited row — same
 * defensive posture as the use-time guard in the facilitator itself.
 *
 * `x402.rpc_url` is defense-in-depth only: `X402Network.rpcUrl` is NOT NULL and
 * validated as an http(s) URL on write, so it should never be blank. It is
 * checked rather than assumed because a blank value would break balance reads
 * and self-hosted settle alike — but it is NOT reconciling a disagreement
 * between callers, and its passing tells you nothing you did not already know.
 *
 * `isReady` covers receiving only. Outbound spending (purchasing wallet +
 * funded budget) is reported as checks but is an optional step — an operator
 * who only sells never configures it, and must not be told the rail is broken.
 */
export function evaluateX402Readiness(input: X402ReadinessInput): RailReadiness {
	const enabledChains = input.chains.filter((chain) => chain.isEnabled);

	if (enabledChains.length === 0) {
		return {
			rail: 'X402',
			isReady: false,
			Checks: [
				check('x402.enabled_chain', 'Enabled chain', false, 'No enabled x402 chain for this environment'),
				check('x402.rpc_url', 'RPC endpoint', false, 'Needs an enabled chain first'),
				check('x402.facilitator', 'Facilitator', false, 'Needs an enabled chain first'),
				check('x402.selling_wallet', 'Selling wallet', false, 'Needs an enabled chain first'),
				check('x402.purchasing_wallet', 'Purchasing wallet', false, 'Needs an enabled chain first'),
				check('x402.budget', 'Spending budget', false, 'Needs an enabled chain first'),
			],
		};
	}

	const evaluated = enabledChains.map((chain) => {
		// Should always pass — see the note above; kept as a cheap guard, not a
		// reconciliation of differing definitions.
		const hasRpc = (chain.rpcUrl ?? '').trim().length > 0;
		// Exactly one facilitator mode: self-hosted wallet XOR remote URL. Both
		// set is rejected downstream by getFacilitatorForNetwork, so reporting it
		// as complete here would promise a rail that throws on first settle.
		const hasWalletFacilitator = chain.facilitatorWalletId !== null;
		const hasUrlFacilitator = chain.facilitatorUrl !== null;
		const hasFacilitator = hasWalletFacilitator !== hasUrlFacilitator;

		const checks: RailReadinessCheck[] = [
			check('x402.enabled_chain', 'Enabled chain', true, chain.caip2Id),
			check('x402.rpc_url', 'RPC endpoint', hasRpc, hasRpc ? null : 'No RPC URL configured for this chain'),
			check(
				'x402.facilitator',
				'Facilitator',
				hasFacilitator,
				hasFacilitator
					? hasWalletFacilitator
						? 'Self-hosted facilitator wallet'
						: 'Remote facilitator URL'
					: hasWalletFacilitator && hasUrlFacilitator
						? 'Both a facilitator wallet and URL are set — configure exactly one'
						: 'No facilitator wallet or URL configured',
			),
			check(
				'x402.selling_wallet',
				'Selling wallet',
				chain.sellingWalletCount > 0,
				chain.sellingWalletCount > 0 ? null : 'No selling wallet bound to this chain',
			),
			check(
				'x402.purchasing_wallet',
				'Purchasing wallet',
				chain.purchasingWalletCount > 0,
				chain.purchasingWalletCount > 0 ? null : 'Optional — needed only to pay other agents',
			),
			check(
				'x402.budget',
				'Spending budget',
				chain.fundedBudgetCount > 0,
				chain.fundedBudgetCount > 0 ? null : 'Optional — needed only to pay other agents',
			),
		];

		return { checks, passed: checks.filter((entry) => entry.isComplete).length };
	});

	// Receiving is what makes the rail usable, mirroring isX402SetUpForEnv:
	// any single fully-configured chain is enough.
	const canReceive = (entry: { checks: RailReadinessCheck[] }) =>
		entry.checks.every((c) =>
			c.id === 'x402.rpc_url' || c.id === 'x402.facilitator' || c.id === 'x402.enabled_chain' ? c.isComplete : true,
		);

	const readyChain = evaluated.find(canReceive);
	const best = readyChain ?? evaluated.reduce((a, b) => (b.passed > a.passed ? b : a));

	return { rail: 'X402', isReady: readyChain !== undefined, Checks: best.checks };
}
