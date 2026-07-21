import { Network } from '@/generated/prisma/client';
import { DEFAULTS } from '@masumi/payment-core/config';
import {
	evaluateCardanoReadiness,
	evaluateX402Readiness,
	type CardanoReadinessInput,
	type X402ReadinessInput,
} from './service';

const isComplete = (rail: { Checks: { id: string; isComplete: boolean }[] }, id: string) =>
	rail.Checks.find((check) => check.id === id)?.isComplete;

const detailOf = (rail: { Checks: { id: string; detail: string | null }[] }, id: string) =>
	rail.Checks.find((check) => check.id === id)?.detail;

function cardanoSource(overrides: Partial<CardanoReadinessInput['sources'][number]> = {}) {
	return {
		// Default to the current Preprod contract so the sync check passes unless
		// a test deliberately retires it.
		policyId: DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD,
		smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD,
		requiredAdminSignatures: 2,
		disablePaymentAt: null as Date | null,
		adminWalletCount: 3,
		rpcProviderApiKey: 'preprodBlockfrostKey',
		sellingWalletCount: 1,
		purchasingWalletCount: 1,
		...overrides,
	};
}

function x402Chain(overrides: Partial<X402ReadinessInput['chains'][number]> = {}) {
	return {
		caip2Id: 'eip155:84532',
		isEnabled: true,
		rpcUrl: 'https://sepolia.base.org',
		facilitatorWalletId: 'wallet_1' as string | null,
		facilitatorUrl: null as string | null,
		sellingWalletCount: 1,
		purchasingWalletCount: 0,
		fundedBudgetCount: 0,
		...overrides,
	};
}

describe('evaluateCardanoReadiness', () => {
	it('reports every check incomplete when no V2 source exists', () => {
		const rail = evaluateCardanoReadiness({ network: Network.Preprod, sources: [] });

		expect(rail.isReady).toBe(false);
		expect(rail.Checks.every((check) => !check.isComplete)).toBe(true);
		expect(detailOf(rail, 'cardano.payment_source')).toContain('No active Web3CardanoV2 payment source');
	});

	it('is ready when a fully configured source exists', () => {
		const rail = evaluateCardanoReadiness({ network: Network.Preprod, sources: [cardanoSource()] });

		expect(rail.isReady).toBe(true);
		expect(rail.Checks.every((check) => check.isComplete)).toBe(true);
	});

	it('blocks on a retired contract policy id', () => {
		const rail = evaluateCardanoReadiness({
			network: Network.Preprod,
			sources: [cardanoSource({ policyId: 'retired0000000000000000000000000000000000000000000' })],
		});

		expect(rail.isReady).toBe(false);
		expect(isComplete(rail, 'cardano.contract_current')).toBe(false);
	});

	it('treats a custom contract address as current, not a fault', () => {
		const rail = evaluateCardanoReadiness({
			network: Network.Preprod,
			sources: [cardanoSource({ smartContractAddress: 'addr_test1_custom_deployment' })],
		});

		expect(rail.isReady).toBe(true);
		expect(isComplete(rail, 'cardano.contract_current')).toBe(true);
		expect(detailOf(rail, 'cardano.contract_current')).toContain('Custom contract address');
	});

	it('blocks when admin wallets are fewer than the required signatures', () => {
		const rail = evaluateCardanoReadiness({
			network: Network.Preprod,
			sources: [cardanoSource({ adminWalletCount: 1, requiredAdminSignatures: 2 })],
		});

		expect(rail.isReady).toBe(false);
		expect(detailOf(rail, 'cardano.admin_signatures')).toContain('2 signature(s) required');
	});

	it.each([
		['blank rpc key', { rpcProviderApiKey: '   ' }, 'cardano.rpc_provider'],
		['missing rpc key', { rpcProviderApiKey: null }, 'cardano.rpc_provider'],
		['no selling wallet', { sellingWalletCount: 0 }, 'cardano.selling_wallet'],
		['no purchasing wallet', { purchasingWalletCount: 0 }, 'cardano.purchasing_wallet'],
		['payments disabled', { disablePaymentAt: new Date() }, 'cardano.payments_enabled'],
	])('blocks on %s', (_name, overrides, expectedFailingCheck) => {
		const rail = evaluateCardanoReadiness({ network: Network.Preprod, sources: [cardanoSource(overrides)] });

		expect(rail.isReady).toBe(false);
		expect(isComplete(rail, expectedFailingCheck)).toBe(false);
	});

	it('stays ready when one good source sits alongside a broken one', () => {
		const rail = evaluateCardanoReadiness({
			network: Network.Preprod,
			sources: [cardanoSource({ sellingWalletCount: 0, rpcProviderApiKey: null }), cardanoSource()],
		});

		expect(rail.isReady).toBe(true);
		expect(rail.Checks.every((check) => check.isComplete)).toBe(true);
	});

	it('reports the closest-to-done source when none is ready', () => {
		const rail = evaluateCardanoReadiness({
			network: Network.Preprod,
			sources: [
				cardanoSource({ sellingWalletCount: 0, purchasingWalletCount: 0, rpcProviderApiKey: null }),
				cardanoSource({ sellingWalletCount: 0 }),
			],
		});

		expect(rail.isReady).toBe(false);
		// The better source only misses the selling wallet, so that is the single
		// remaining step shown rather than the worse source's three.
		expect(rail.Checks.filter((check) => !check.isComplete).map((check) => check.id)).toEqual([
			'cardano.selling_wallet',
		]);
	});
});

describe('evaluateX402Readiness', () => {
	it('reports every check incomplete when no chain is enabled', () => {
		const rail = evaluateX402Readiness({ chains: [x402Chain({ isEnabled: false })] });

		expect(rail.isReady).toBe(false);
		expect(rail.Checks.every((check) => !check.isComplete)).toBe(true);
	});

	it('is ready to receive with an enabled chain, RPC URL and a facilitator wallet', () => {
		const rail = evaluateX402Readiness({ chains: [x402Chain()] });

		expect(rail.isReady).toBe(true);
		expect(detailOf(rail, 'x402.facilitator')).toBe('Self-hosted facilitator wallet');
	});

	it('is ready with a remote facilitator URL instead of a wallet', () => {
		const rail = evaluateX402Readiness({
			chains: [x402Chain({ facilitatorWalletId: null, facilitatorUrl: 'https://facilitator.example' })],
		});

		expect(rail.isReady).toBe(true);
		expect(detailOf(rail, 'x402.facilitator')).toBe('Remote facilitator URL');
	});

	// Defense-in-depth only: rpcUrl is NOT NULL and URL-validated on write, so a
	// blank value should be unreachable in practice. Asserted so the guard cannot
	// silently rot, NOT because callers disagree about it.
	it('is NOT ready when a facilitator is set but the RPC URL is blank', () => {
		const rail = evaluateX402Readiness({ chains: [x402Chain({ rpcUrl: '   ' })] });

		expect(rail.isReady).toBe(false);
		expect(isComplete(rail, 'x402.rpc_url')).toBe(false);
	});

	it('rejects a chain with BOTH facilitator modes set', () => {
		const rail = evaluateX402Readiness({
			chains: [x402Chain({ facilitatorWalletId: 'wallet_1', facilitatorUrl: 'https://facilitator.example' })],
		});

		expect(rail.isReady).toBe(false);
		expect(detailOf(rail, 'x402.facilitator')).toContain('configure exactly one');
	});

	it('stays ready without a purchasing wallet or budget, since paying is optional', () => {
		const rail = evaluateX402Readiness({ chains: [x402Chain({ purchasingWalletCount: 0, fundedBudgetCount: 0 })] });

		expect(rail.isReady).toBe(true);
		expect(isComplete(rail, 'x402.purchasing_wallet')).toBe(false);
		expect(isComplete(rail, 'x402.budget')).toBe(false);
	});

	it('ignores disabled chains when picking the reported chain', () => {
		const rail = evaluateX402Readiness({
			chains: [x402Chain({ isEnabled: false, caip2Id: 'eip155:1' }), x402Chain({ caip2Id: 'eip155:84532' })],
		});

		expect(rail.isReady).toBe(true);
		expect(detailOf(rail, 'x402.enabled_chain')).toBe('eip155:84532');
	});

	it('is ready when any one enabled chain is fully configured', () => {
		const rail = evaluateX402Readiness({
			chains: [x402Chain({ caip2Id: 'eip155:1', facilitatorWalletId: null }), x402Chain()],
		});

		expect(rail.isReady).toBe(true);
	});
});
