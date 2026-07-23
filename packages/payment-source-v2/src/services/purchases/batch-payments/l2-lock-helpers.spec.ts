import { describe, it, expect } from '@jest/globals';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import {
	buildL2LockDatumParams,
	createTrustedL2LockWindow,
	isHotWalletEligibleForL2Lock,
	L2_LOCK_HEAD_CLOCK_MAX_AGE_MS,
	mapPaidFundsToAssets,
	planL2LockValue,
	requireFreshL2LockHeadClock,
	retainInitialL2LockAfterSubmitFailure,
	resolveL2BuyerReturnAddress,
	selectInHeadFundingUtxos,
	type L2FundingUtxo,
	type L2LockRequestFields,
} from './l2-lock-helpers';

describe('L2 lock minimum-ADA value planning', () => {
	it('adds minimum ADA for a token-only lock and records it for buyer return', () => {
		const plan = planL2LockValue([{ unit: 'policy.asset', amount: 7n }], () => 3_000_000n);

		expect(plan.collateralReturnLovelace).toBe(3_000_000n);
		expect(plan.outputFunds).toEqual([
			{ unit: 'policy.asset', amount: 7n },
			{ unit: '', amount: 3_000_000n },
		]);
	});

	it('does not add collateral when requested ADA already covers the minimum', () => {
		const plan = planL2LockValue([{ unit: '', amount: 5_000_000n }], () => 3_000_000n);

		expect(plan.collateralReturnLovelace).toBe(0n);
		expect(plan.outputFunds).toEqual([{ unit: '', amount: 5_000_000n }]);
	});

	it('raises a small top-up to the contract minimum collateral return', () => {
		const plan = planL2LockValue([{ unit: 'lovelace', amount: 2_500_000n }], () => 3_000_000n);

		expect(plan.collateralReturnLovelace).toBe(1_435_230n);
		expect(plan.outputFunds).toEqual([{ unit: '', amount: 3_935_230n }]);
	});

	it('recomputes the minimum after the collateral integer changes datum size', () => {
		const seen: bigint[] = [];
		const plan = planL2LockValue([{ unit: 'policy.asset', amount: 1n }], (collateral) => {
			seen.push(collateral);
			return collateral === 0n ? 3_000_000n : 3_010_000n;
		});

		expect(plan.collateralReturnLovelace).toBe(3_010_000n);
		expect(seen).toEqual([0n, 3_000_000n, 3_010_000n, 3_010_000n]);
	});

	it('rejects non-positive requested amounts', () => {
		expect(() => planL2LockValue([{ unit: 'policy.asset', amount: 0n }], () => 3_000_000n)).toThrow(
			/positive amounts/i,
		);
	});
});

describe('L2 initial-lock deadline safety', () => {
	const observedAtMs = 1_751_959_200_000;
	const payByTime = BigInt(observedAtMs + 90_000);
	const freshClock = {
		chainTimeMs: observedAtMs,
		receivedAtMs: observedAtMs - 20_000,
	};

	it('rejects when no live head clock has been observed', () => {
		expect(() =>
			requireFreshL2LockHeadClock({
				headClock: undefined,
				payByTime,
				observedAtMs,
			}),
		).toThrow(/requires a live Hydra head clock/i);
	});

	it('rejects a stale cached head clock', () => {
		expect(() =>
			requireFreshL2LockHeadClock({
				headClock: {
					chainTimeMs: observedAtMs - 120_000,
					receivedAtMs: observedAtMs - L2_LOCK_HEAD_CLOCK_MAX_AGE_MS - 1,
				},
				payByTime,
				observedAtMs,
			}),
		).toThrow(/clock is stale/i);
	});

	it('rejects a request whose deadline has passed on the head clock', () => {
		const deadlineMs = Number(payByTime);
		expect(() =>
			requireFreshL2LockHeadClock({
				headClock: { chainTimeMs: deadlineMs, receivedAtMs: deadlineMs },
				payByTime,
				observedAtMs: deadlineMs,
			}),
		).toThrow(/request has expired/i);
	});

	it('rejects a future-dated receipt timestamp instead of treating it as fresh', () => {
		expect(() =>
			requireFreshL2LockHeadClock({
				headClock: { chainTimeMs: observedAtMs, receivedAtMs: observedAtMs + 5_001 },
				payByTime,
				observedAtMs,
			}),
		).toThrow(/clock from the future/i);
	});

	it('rejects a materially future chain time even when its receipt timestamp is fresh', () => {
		expect(() =>
			requireFreshL2LockHeadClock({
				headClock: { chainTimeMs: observedAtMs + 5_001, receivedAtMs: observedAtMs },
				payByTime,
				observedAtMs,
			}),
		).toThrow(/chain time from the future/i);
	});

	it('binds the transaction upper validity time no later than payByTime', () => {
		const window = createTrustedL2LockWindow({
			network: 'preprod',
			payByTime,
			headClock: freshClock,
			observedAtMs,
			windowOptions: {
				beforeBufferMs: 20_000,
				afterBufferMs: 300_000,
				validitySlotBuffer: 50,
			},
		});

		expect(window.trustedHeadTimeMs).toBe(freshClock.chainTimeMs);
		expect(window.invalidBefore).toBeLessThan(window.invalidAfter);
		expect(BigInt(window.invalidAfterMs)).toBeLessThanOrEqual(payByTime);
	});

	it('overrides an untrusted stale window anchor with the live head clock', () => {
		const window = createTrustedL2LockWindow({
			network: 'preprod',
			payByTime,
			headClock: freshClock,
			observedAtMs,
			windowOptions: {
				nowMs: observedAtMs + 10_000_000,
				afterBufferMs: 30_000,
			},
		});

		expect(window.trustedHeadTimeMs).toBe(observedAtMs);
		expect(BigInt(window.invalidAfterMs)).toBeLessThanOrEqual(payByTime);
	});
});

describe('L2 wallet routing safety', () => {
	it('allows every wallet when the request is not limited', () => {
		expect(
			isHotWalletEligibleForL2Lock({ isLimitedToHotWallets: false, HotWalletLimit: [{ id: 'wallet-a' }] }, 'wallet-b'),
		).toBe(true);
	});

	it('allows only an explicitly listed wallet when the request is limited', () => {
		const request = { isLimitedToHotWallets: true, HotWalletLimit: [{ id: 'wallet-a' }] };
		expect(isHotWalletEligibleForL2Lock(request, 'wallet-a')).toBe(true);
		expect(isHotWalletEligibleForL2Lock(request, 'wallet-b')).toBe(false);
	});

	it('allows no wallets when a limited request has an empty limit', () => {
		expect(isHotWalletEligibleForL2Lock({ isLimitedToHotWallets: true, HotWalletLimit: [] }, 'wallet-a')).toBe(false);
	});

	it('has no post-reservation outcome that authorizes another-wallet retry', () => {
		const outcomes = [
			{ status: 'accepted', txHash: 'tx-1' },
			{ status: 'accepted-db-pending', txHash: 'tx-1', error: new Error('db') },
			{ status: 'ambiguous', intendedTxHash: 'tx-1', error: new Error('rejected-or-lost') },
		] satisfies import('./l2-lock-helpers').L2LockAttemptOutcome[];

		expect(outcomes.map(({ status }) => status)).toEqual(['accepted', 'accepted-db-pending', 'ambiguous']);
	});

	it('treats an explicit Hydra TxInvalid response as ambiguous and retains the initial lock', () => {
		const rejection = new Error('HydraTransactionRejectedError: Transaction is invalid');
		expect(retainInitialL2LockAfterSubmitFailure('tx-1', rejection)).toEqual({
			status: 'ambiguous',
			intendedTxHash: 'tx-1',
			error: rejection,
		});
	});
});

describe('resolveL2BuyerReturnAddress', () => {
	it('uses the request buyer return address when present', () => {
		expect(resolveL2BuyerReturnAddress('addr_buyer', 'addr_collection')).toBe('addr_buyer');
	});

	it('falls back to the wallet collection address when the request has none', () => {
		expect(resolveL2BuyerReturnAddress(null, 'addr_collection')).toBe('addr_collection');
	});

	it('treats an empty-string request address as a real value (no fallback)', () => {
		// `??` only falls back on null/undefined — an empty string is preserved.
		expect(resolveL2BuyerReturnAddress('', 'addr_collection')).toBe('');
	});

	it('returns null when neither request nor wallet has an address', () => {
		expect(resolveL2BuyerReturnAddress(null, null)).toBeNull();
	});
});

describe('mapPaidFundsToAssets', () => {
	it('normalises an empty unit to lovelace', () => {
		expect(mapPaidFundsToAssets([{ unit: '', amount: 5_000_000n }])).toEqual([
			{ unit: 'lovelace', quantity: '5000000' },
		]);
	});

	it('preserves native asset units and stringifies bigint amounts', () => {
		expect(
			mapPaidFundsToAssets([
				{ unit: '', amount: 2_000_000n },
				{ unit: 'policy.assetname', amount: 42n },
			]),
		).toEqual([
			{ unit: 'lovelace', quantity: '2000000' },
			{ unit: 'policy.assetname', quantity: '42' },
		]);
	});

	it('returns an empty array for no funds', () => {
		expect(mapPaidFundsToAssets([])).toEqual([]);
	});
});

describe('buildL2LockDatumParams', () => {
	const request: L2LockRequestFields = {
		buyerReturnAddress: 'addr_buyer_return',
		sellerReturnAddress: 'addr_seller_return',
		blockchainIdentifier: 'bid-123',
		inputHash: 'inputhash-abc',
		payByTime: 1000n,
		submitResultTime: 2000n,
		unlockTime: 3000n,
		externalDisputeUnlockTime: 4000n,
	};

	const baseArgs = {
		request,
		buyerAddress: 'addr_buyer',
		sellerAddress: 'addr_seller',
		buyerReturnAddress: 'addr_buyer_return',
		collateralReturnLovelace: 2_000_000n,
	};

	it('produces the initial FundsLocked state with no result', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.state).toBe(SmartContractState.FundsLocked);
		expect(params.resultHash).toBeNull();
	});

	it('carries the calculated collateral return and zeroes both cooldowns', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.collateralReturnLovelace).toBe(2_000_000n);
		expect(params.newCooldownTimeSeller).toBe(0n);
		expect(params.newCooldownTimeBuyer).toBe(0n);
	});

	it('maps addresses and identifiers through unchanged', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.buyerAddress).toBe('addr_buyer');
		expect(params.sellerAddress).toBe('addr_seller');
		expect(params.buyerReturnAddress).toBe('addr_buyer_return');
		expect(params.sellerReturnAddress).toBe('addr_seller_return');
		expect(params.blockchainIdentifier).toBe('bid-123');
		expect(params.inputHash).toBe('inputhash-abc');
	});

	it('carries the request time windows through verbatim', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.payByTime).toBe(1000n);
		expect(params.resultTime).toBe(2000n);
		expect(params.unlockTime).toBe(3000n);
		expect(params.externalDisputeUnlockTime).toBe(4000n);
	});

	it('uses the resolved buyerReturnAddress argument, not the raw request field', () => {
		const params = buildL2LockDatumParams({
			...baseArgs,
			request: { ...request, buyerReturnAddress: null },
			buyerReturnAddress: 'addr_collection_fallback',
		});
		expect(params.buyerReturnAddress).toBe('addr_collection_fallback');
	});
});

describe('selectInHeadFundingUtxos', () => {
	const SPLITTER = 5_000_000n;
	const MIN_CHANGE = 2_000_000n;
	const TOKEN = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
	const ada = (n: bigint) => ({ unit: 'lovelace', quantity: n.toString() });
	const asset = (unit: string, n: bigint) => ({ unit, quantity: n.toString() });
	const utxo = (
		idx: number,
		amount: Array<{ unit: string; quantity: string }>,
		plutusData?: string,
	): L2FundingUtxo => ({
		input: { txHash: `tx${idx}`, outputIndex: idx },
		output: { address: 'addr_buyer', amount, plutusData: plutusData ?? null },
	});
	const lovelacePaid = (n: bigint) => [{ unit: '', amount: n }];

	it('selects a single pure-ADA UTxO that covers lock + splitter + change', () => {
		const utxos = [utxo(0, [ada(20_000_000n)])];
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE);
		expect(selected).toHaveLength(1);
		expect(selected[0].input.txHash).toBe('tx0');
	});

	it('selects an asset-carrying UTxO for an ADA payment (faucet token no longer disqualifies it)', () => {
		// The buyer's only funds ride on a UTxO that also carries a faucet token.
		const utxos = [utxo(0, [ada(20_000_000n), asset(TOKEN, 1_000_000_000n)])];
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE);
		expect(selected).toHaveLength(1);
		expect(selected[0].input.txHash).toBe('tx0');
	});

	it('pulls the token-bearing UTxO when the payment itself is in a native token', () => {
		const pureAda = utxo(0, [ada(20_000_000n)]);
		const tokenUtxo = utxo(1, [ada(3_000_000n), asset(TOKEN, 100n)]);
		const selected = selectInHeadFundingUtxos(
			[pureAda, tokenUtxo],
			[
				{ unit: TOKEN, amount: 100n },
				{ unit: '', amount: 5_000_000n },
			],
			SPLITTER,
			MIN_CHANGE,
		);
		const hashes = selected.map((u) => u.input.txHash);
		expect(hashes).toContain('tx1'); // the token UTxO must be selected to cover the token
	});

	it('combines multiple small UTxOs to reach the target (any UTxO form)', () => {
		const utxos = [utxo(0, [ada(4_000_000n)]), utxo(1, [ada(5_000_000n)]), utxo(2, [ada(6_000_000n)])];
		// need 5 + 5 + 2 = 12 ADA; largest-first: 6 + 5 = 11 (<12) + 4 = 15 (>=12)
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE);
		expect(selected).toHaveLength(3);
	});

	it('ignores script (plutusData) UTxOs — they are escrow outputs, not spendable', () => {
		const utxos = [utxo(0, [ada(50_000_000n)], 'd8799fff')];
		expect(() => selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE)).toThrow(
			/no spendable/i,
		);
	});

	it('throws with the lovelace shortfall when ADA is insufficient', () => {
		const utxos = [utxo(0, [ada(5_000_000n)])]; // needs 12 ADA
		expect(() => selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE)).toThrow(
			/insufficient in-head funds/i,
		);
	});

	it('throws when a required token is not present in any UTxO', () => {
		const utxos = [utxo(0, [ada(50_000_000n)])];
		expect(() =>
			selectInHeadFundingUtxos(
				utxos,
				[
					{ unit: TOKEN, amount: 100n },
					{ unit: '', amount: 5_000_000n },
				],
				SPLITTER,
				MIN_CHANGE,
			),
		).toThrow(/insufficient in-head funds/i);
	});

	it('tops up with a pure-ADA UTxO when asset-heavy change needs more than the static floor', () => {
		// tx0 covers the base target (5 paid + 5 splitter + 2 floor = 12 < 13) but its
		// leftover tokens push the change output's real min-UTxO to 4 ADA. The
		// selector must add the pure-ADA tx1 rather than fail later at submitTx.
		const utxos = [
			utxo(0, [ada(13_000_000n), asset(TOKEN, 5n), asset(`${TOKEN}beef`, 7n)]),
			utxo(1, [ada(10_000_000n)]),
		];
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE, (changeAssets) =>
			changeAssets.length > 0 ? 4_000_000n : 0n,
		);
		expect(selected.map((u) => u.input.txHash).sort()).toEqual(['tx0', 'tx1']);
	});

	it('keeps the static floor when the change carries no assets', () => {
		const utxos = [utxo(0, [ada(20_000_000n)])];
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE, (changeAssets) =>
			changeAssets.length > 0 ? 4_000_000n : 0n,
		);
		expect(selected).toHaveLength(1);
	});

	it('throws with the change min-UTxO shortfall when no top-up UTxO exists', () => {
		const utxos = [utxo(0, [ada(13_000_000n), asset(TOKEN, 5n)])];
		expect(() =>
			selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE, () => 4_000_000n),
		).toThrow(/change output needs/i);
	});
});

describe('planL2LockValue duplicate-unit aggregation', () => {
	const TOKEN = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

	it('aggregates duplicate-unit PaidFunds rows into one output asset entry', () => {
		const plan = planL2LockValue(
			[
				{ unit: TOKEN, amount: 40n },
				{ unit: TOKEN, amount: 60n },
				{ unit: '', amount: 5_000_000n },
			],
			() => 1_000_000n,
		);
		const tokenEntries = plan.outputFunds.filter((f) => f.unit === TOKEN);
		expect(tokenEntries).toHaveLength(1);
		expect(tokenEntries[0].amount).toBe(100n);
		// mapPaidFundsToAssets over the plan therefore yields one row per unit.
		const units = mapPaidFundsToAssets(plan.outputFunds).map((a) => a.unit);
		expect(new Set(units).size).toBe(units.length);
	});
});
