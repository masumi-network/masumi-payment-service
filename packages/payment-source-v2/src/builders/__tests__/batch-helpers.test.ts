import type { UTxO } from '@meshsdk/core';
import {
	assertNoCollateralOverlap,
	assertTxSizeWithinLimit,
	computeCollateralFromExUnits,
	countFeeEligibleUtxos,
	capRegistryMintFundingLovelace,
	shouldEmitWalletSplitter,
	isRegistryTxInputSelectionError,
	intersectTxWindows,
	isTxSizeWithinLimit,
	MAX_SAFE_TX_BYTES,
	pickBatchCollateral,
	shrinkBatchToFit,
	type BatchShrinkReason,
} from '../batch-helpers';

/** Build a minimal mesh UTxO for tests. */
function makeUtxo(opts: {
	txHash: string;
	outputIndex?: number;
	lovelace?: string;
	extraAssets?: Array<{ unit: string; quantity: string }>;
	address?: string;
}): UTxO {
	const lovelaceQty = opts.lovelace ?? '0';
	const amount = [{ unit: 'lovelace', quantity: lovelaceQty }, ...(opts.extraAssets ?? [])];
	return {
		input: { txHash: opts.txHash, outputIndex: opts.outputIndex ?? 0 },
		output: {
			address: opts.address ?? 'addr_test1qrtest',
			amount,
		},
	};
}

describe('intersectTxWindows', () => {
	it('returns null for empty input', () => {
		expect(intersectTxWindows([])).toBeNull();
	});

	it('returns the only window unchanged for a single input', () => {
		const w = { invalidBefore: 100, invalidAfter: 200 };
		expect(intersectTxWindows([w])).toEqual(w);
	});

	it('intersects two overlapping windows', () => {
		const result = intersectTxWindows([
			{ invalidBefore: 100, invalidAfter: 200 },
			{ invalidBefore: 150, invalidAfter: 250 },
		]);
		expect(result).toEqual({ invalidBefore: 150, invalidAfter: 200 });
	});

	it('intersects N windows by taking max(before) and min(after)', () => {
		const result = intersectTxWindows([
			{ invalidBefore: 10, invalidAfter: 1000 },
			{ invalidBefore: 50, invalidAfter: 800 },
			{ invalidBefore: 75, invalidAfter: 500 },
			{ invalidBefore: 25, invalidAfter: 900 },
		]);
		expect(result).toEqual({ invalidBefore: 75, invalidAfter: 500 });
	});

	it('returns null when intersection is empty', () => {
		const result = intersectTxWindows([
			{ invalidBefore: 100, invalidAfter: 200 },
			{ invalidBefore: 300, invalidAfter: 400 },
		]);
		expect(result).toBeNull();
	});

	it('treats touching boundaries as non-empty (before == after is one slot)', () => {
		const result = intersectTxWindows([
			{ invalidBefore: 100, invalidAfter: 200 },
			{ invalidBefore: 200, invalidAfter: 300 },
		]);
		expect(result).toEqual({ invalidBefore: 200, invalidAfter: 200 });
	});
});

describe('countFeeEligibleUtxos', () => {
	it('returns 0 when asset input and collateral consume every UTxO', () => {
		const utxos = [
			makeUtxo({ txHash: 'tx', outputIndex: 0, lovelace: '5000000' }),
			makeUtxo({
				txHash: 'tx',
				outputIndex: 1,
				lovelace: '4825523',
				extraAssets: [{ unit: 'policy.name', quantity: '1' }],
			}),
		];
		expect(
			countFeeEligibleUtxos(utxos, [
				{ txHash: 'tx', outputIndex: 0 },
				{ txHash: 'tx', outputIndex: 1 },
			]),
		).toBe(0);
	});

	it('counts UTxOs not in the exclude set', () => {
		const utxos = [makeUtxo({ txHash: 'a', lovelace: '5000000' }), makeUtxo({ txHash: 'b', lovelace: '8000000' })];
		expect(countFeeEligibleUtxos(utxos, [{ txHash: 'a', outputIndex: 0 }])).toBe(1);
	});
});

describe('shouldEmitWalletSplitter', () => {
	it('skips splitter when wallet already has 3 UTxOs (fee-UTxO split prep)', () => {
		const utxos = [
			makeUtxo({ txHash: 'a', lovelace: '5000000' }),
			makeUtxo({ txHash: 'b', lovelace: '3000000' }),
			makeUtxo({ txHash: 'c', lovelace: '1470673' }),
		];
		expect(shouldEmitWalletSplitter(utxos, [utxos[1]])).toBe(false);
	});

	it('skips splitter when sole fee UTxO cannot fund 5 ADA splitter plus fees', () => {
		const utxos = [makeUtxo({ txHash: 'a', lovelace: '3000000' }), makeUtxo({ txHash: 'b', lovelace: '5000000' })];
		expect(shouldEmitWalletSplitter(utxos, [utxos[0]])).toBe(false);
	});

	it('emits splitter for 2-UTxO wallet with a large sole fee input', () => {
		const utxos = [makeUtxo({ txHash: 'a', lovelace: '8000000' }), makeUtxo({ txHash: 'b', lovelace: '6000000' })];
		expect(shouldEmitWalletSplitter(utxos, [utxos[0]])).toBe(true);
	});
});

describe('isRegistryTxInputSelectionError', () => {
	it('matches insufficient and depleted mesh input-selection failures', () => {
		expect(isRegistryTxInputSelectionError(new Error('UTxO Balance Insufficient'))).toBe(true);
		expect(isRegistryTxInputSelectionError(new Error('UTxO Fully Depleted'))).toBe(true);
		expect(isRegistryTxInputSelectionError(new Error('something else'))).toBe(false);
	});
});

describe('capRegistryMintFundingLovelace', () => {
	it('caps default 5 ADA funding to available non-collateral lovelace', () => {
		const collateral = makeUtxo({ txHash: 'c', lovelace: '5000000' });
		const asset = makeUtxo({
			txHash: 'a',
			outputIndex: 2,
			lovelace: '1470673',
			extraAssets: [{ unit: 'policy.name', quantity: '1' }],
		});
		const fee = makeUtxo({ txHash: 'f', lovelace: '3000000' });
		const capped = capRegistryMintFundingLovelace([collateral, fee, asset], collateral, [asset], '5000000');
		// 3M fee + 1.47M asset - 3M plutus reserve ≈ 1.47M → clamped to min mint output
		expect(BigInt(capped)).toBe(1_500_000n);
	});
});

describe('pickBatchCollateral', () => {
	it('returns null when there are no UTxOs', () => {
		expect(pickBatchCollateral([], [])).toBeNull();
	});

	it('picks the smallest qualifying pure-ADA UTxO', () => {
		const utxos = [
			makeUtxo({ txHash: 'a', lovelace: '20000000' }),
			makeUtxo({ txHash: 'b', lovelace: '5000000' }),
			makeUtxo({ txHash: 'c', lovelace: '10000000' }),
		];
		const picked = pickBatchCollateral(utxos, []);
		expect(picked?.input.txHash).toBe('b');
	});

	it('skips UTxOs that are also in the spending set', () => {
		const utxos = [
			makeUtxo({ txHash: 'spend', outputIndex: 0, lovelace: '6000000' }),
			makeUtxo({ txHash: 'free', outputIndex: 0, lovelace: '7000000' }),
		];
		const picked = pickBatchCollateral(utxos, [{ txHash: 'spend', outputIndex: 0 }]);
		expect(picked?.input.txHash).toBe('free');
	});

	it('treats different outputIndex on same txHash as distinct', () => {
		const utxos = [
			makeUtxo({ txHash: 'tx', outputIndex: 0, lovelace: '6000000' }),
			makeUtxo({ txHash: 'tx', outputIndex: 1, lovelace: '7000000' }),
		];
		const picked = pickBatchCollateral(utxos, [{ txHash: 'tx', outputIndex: 0 }]);
		expect(picked?.input.outputIndex).toBe(1);
	});

	it('prefers pure-ADA over native-token UTxOs even when the native-token one has more lovelace', () => {
		const utxos = [
			makeUtxo({
				txHash: 'mixed',
				lovelace: '20000000',
				extraAssets: [{ unit: 'policy.name', quantity: '1' }],
			}),
			makeUtxo({ txHash: 'pure', lovelace: '8000000' }),
		];
		const picked = pickBatchCollateral(utxos, []);
		expect(picked?.input.txHash).toBe('pure');
	});

	it('falls back to a native-token UTxO when no pure-ADA candidate exists', () => {
		// Mirrors V1 register's behavior — selling/purchasing wallets that have
		// accumulated NFT registration tokens often have no pure-ADA UTxO
		// available, and the V1 builder happily uses the native-token UTxO as
		// collateral (mesh emits collateral_return_output to refund the assets).
		const utxos = [
			makeUtxo({
				txHash: 'nft-a',
				lovelace: '12000000',
				extraAssets: [{ unit: 'policy.nftA', quantity: '1' }],
			}),
			makeUtxo({
				txHash: 'nft-b',
				lovelace: '7000000',
				extraAssets: [{ unit: 'policy.nftB', quantity: '1' }],
			}),
		];
		const picked = pickBatchCollateral(utxos, []);
		// Smallest qualifying native-token UTxO.
		expect(picked?.input.txHash).toBe('nft-b');
	});

	it('skips UTxOs below the requiredLovelace floor', () => {
		const utxos = [makeUtxo({ txHash: 'small', lovelace: '4000000' }), makeUtxo({ txHash: 'ok', lovelace: '8000000' })];
		const picked = pickBatchCollateral(utxos, [], 5_000_000n);
		expect(picked?.input.txHash).toBe('ok');
	});

	it('honors a custom higher requiredLovelace (e.g. for many-script-input batches)', () => {
		const utxos = [
			makeUtxo({ txHash: 'medium', lovelace: '5000000' }),
			makeUtxo({ txHash: 'big', lovelace: '15000000' }),
		];
		const picked = pickBatchCollateral(utxos, [], 10_000_000n);
		expect(picked?.input.txHash).toBe('big');
	});

	it('returns null when nothing qualifies (every candidate either underfunded or excluded)', () => {
		const utxos = [
			makeUtxo({ txHash: 'tiny', lovelace: '1000000' }),
			makeUtxo({
				txHash: 'mixed-tiny',
				lovelace: '2000000',
				extraAssets: [{ unit: 'p.n', quantity: '1' }],
			}),
		];
		// Both fall below the 5_000_000n floor — neither pure-ADA nor
		// native-token branch finds a candidate.
		expect(pickBatchCollateral(utxos, [])).toBeNull();
	});

	it('treats empty-string asset unit as lovelace for the pure-ADA check', () => {
		const utxos: UTxO[] = [
			{
				input: { txHash: 'empty-unit', outputIndex: 0 },
				output: {
					address: 'addr_test1',
					amount: [{ unit: '', quantity: '6000000' }],
				},
			},
		];
		const picked = pickBatchCollateral(utxos, []);
		expect(picked?.input.txHash).toBe('empty-unit');
	});
});

describe('computeCollateralFromExUnits', () => {
	const protocolParams = {
		// Realistic Cardano values (mainnet).
		priceMem: '0.0577',
		priceStep: '0.0000721',
		collateralPercentage: 150,
	};

	it('returns 0 for an empty budget list', () => {
		expect(computeCollateralFromExUnits([], protocolParams)).toBe(0n);
	});

	it('handles a single redeemer budget', () => {
		// memFee  = ceil(7_000_000 * 0.0577)     = 403_900
		// stepFee = ceil(3_000_000_000 * 0.0000721) = 216_300
		// fee     = 620_200
		// coll    = ceil(620_200 * 150 / 100) = 930_300
		const result = computeCollateralFromExUnits([{ mem: 7_000_000, steps: 3_000_000_000 }], protocolParams);
		expect(result).toBe(930_300n);
	});

	it('sums fees across multiple redeemers and scales by collateralPercentage', () => {
		const result = computeCollateralFromExUnits(
			[
				{ mem: 7_000_000, steps: 3_000_000_000 },
				{ mem: 7_000_000, steps: 3_000_000_000 },
			],
			protocolParams,
		);
		// Two identical redeemers = 2 * 620_200 = 1_240_400 in script fee.
		// coll = ceil(1_240_400 * 150 / 100) = 1_860_600.
		expect(result).toBe(1_860_600n);
	});

	it('accepts numeric prices in addition to decimal strings', () => {
		const result = computeCollateralFromExUnits([{ mem: 1_000_000, steps: 100_000_000 }], {
			priceMem: 0.0577,
			priceStep: 0.0000721,
			collateralPercentage: 150,
		});
		// memFee  = ceil(1_000_000 * 0.0577)   = 57_700
		// stepFee = ceil(100_000_000 * 0.0000721) = 7_210
		// fee     = 64_910
		// coll    = ceil(64_910 * 150 / 100) = 97_365
		expect(result).toBe(97_365n);
	});

	it('returns 0 when all budgets are zero', () => {
		const result = computeCollateralFromExUnits(
			[
				{ mem: 0, steps: 0 },
				{ mem: 0, steps: 0 },
			],
			protocolParams,
		);
		expect(result).toBe(0n);
	});

	it('throws on non-positive collateralPercentage', () => {
		expect(() =>
			computeCollateralFromExUnits([{ mem: 1, steps: 1 }], {
				priceMem: '0.05',
				priceStep: '0.0001',
				collateralPercentage: 0,
			}),
		).toThrow(/collateralPercentage/);
	});

	it('scales linearly with collateralPercentage', () => {
		const result100 = computeCollateralFromExUnits([{ mem: 1_000_000, steps: 100_000_000 }], {
			priceMem: '0.0577',
			priceStep: '0.0000721',
			collateralPercentage: 100,
		});
		const result200 = computeCollateralFromExUnits([{ mem: 1_000_000, steps: 100_000_000 }], {
			priceMem: '0.0577',
			priceStep: '0.0000721',
			collateralPercentage: 200,
		});
		expect(result200).toBe(result100 * 2n);
	});
});

describe('shrinkBatchToFit', () => {
	it('returns empty fit / empty dropped for empty input', () => {
		const result = shrinkBatchToFit<number>([], () => ({ ok: true }));
		expect(result).toEqual({ fit: [], dropped: [], reason: 'none' });
	});

	it('returns all items when the full set already fits', () => {
		const items = [1, 2, 3];
		const result = shrinkBatchToFit(items, () => ({ ok: true }));
		expect(result.fit).toEqual([1, 2, 3]);
		expect(result.dropped).toEqual([]);
		expect(result.reason).toBe('none');
	});

	it('drops items from the END until the subset fits', () => {
		const items = [1, 2, 3, 4, 5];
		const result = shrinkBatchToFit(items, (subset) => ({ ok: subset.length <= 3, reason: 'tx-size' }));
		expect(result.fit).toEqual([1, 2, 3]);
		expect(result.dropped).toEqual([4, 5]);
		expect(result.reason).toBe('tx-size');
	});

	it('drops a single item when N-1 fits and N does not', () => {
		const items = [1, 2, 3];
		const result = shrinkBatchToFit(items, (subset) => ({ ok: subset.length <= 2, reason: 'utxos' }));
		expect(result.fit).toEqual([1, 2]);
		expect(result.dropped).toEqual([3]);
		expect(result.reason).toBe('utxos');
	});

	it('preserves caller-supplied priority order in the fit set', () => {
		// Items pre-sorted by priority — front is highest priority.
		const items = ['high', 'med', 'low'];
		const result = shrinkBatchToFit(items, (subset) => ({ ok: subset.length <= 2, reason: 'window' }));
		expect(result.fit).toEqual(['high', 'med']);
		expect(result.dropped).toEqual(['low']);
	});

	it('returns empty fit when even one item does not satisfy the predicate', () => {
		const items = [1, 2, 3];
		const result = shrinkBatchToFit(items, () => ({ ok: false, reason: 'collateral' }));
		expect(result.fit).toEqual([]);
		expect(result.dropped).toEqual([1, 2, 3]);
		expect(result.reason).toBe('collateral');
	});

	it('returns reason "none" when full input fits without any shrinking', () => {
		const items = [1, 2, 3];
		const result = shrinkBatchToFit(items, () => ({ ok: true, reason: 'window' }));
		expect(result.reason).toBe('none');
	});

	it('handles a single-item batch that fits', () => {
		const items = [42];
		const result = shrinkBatchToFit(items, () => ({ ok: true }));
		expect(result.fit).toEqual([42]);
		expect(result.dropped).toEqual([]);
	});

	it('handles a single-item batch that does not fit', () => {
		const items = [42];
		const result = shrinkBatchToFit(items, () => ({ ok: false, reason: 'tx-size' }));
		expect(result.fit).toEqual([]);
		expect(result.dropped).toEqual([42]);
		expect(result.reason).toBe('tx-size');
	});

	it('threads predicate reason through across multiple shrink steps', () => {
		const items = [1, 2, 3, 4];
		const reasons: BatchShrinkReason[] = ['tx-size', 'utxos', 'window'];
		let call = 0;
		const result = shrinkBatchToFit(items, (subset) => {
			if (subset.length === 1) return { ok: true };
			const reason = reasons[call++] ?? 'collateral';
			return { ok: false, reason };
		});
		expect(result.fit).toEqual([1]);
		// Last observed failing reason before success was 'window'.
		expect(result.reason).toBe('window');
	});
});

describe('assertNoCollateralOverlap', () => {
	const collateral = { input: { txHash: 'coll-tx', outputIndex: 0 } };

	it('does not throw when there is no overlap', () => {
		expect(() =>
			assertNoCollateralOverlap(collateral, [
				{ input: { txHash: 'spend-1', outputIndex: 0 } },
				{ input: { txHash: 'spend-2', outputIndex: 0 } },
			]),
		).not.toThrow();
	});

	it('does not throw on empty spending inputs', () => {
		expect(() => assertNoCollateralOverlap(collateral, [])).not.toThrow();
	});

	it('throws when collateral exactly matches a spending input', () => {
		expect(() =>
			assertNoCollateralOverlap(collateral, [
				{ input: { txHash: 'spend-1', outputIndex: 0 } },
				{ input: { txHash: 'coll-tx', outputIndex: 0 } },
			]),
		).toThrow(/coll-tx#0/);
	});

	it('treats outputIndex as significant — same txHash, different index is OK', () => {
		expect(() =>
			assertNoCollateralOverlap(collateral, [{ input: { txHash: 'coll-tx', outputIndex: 1 } }]),
		).not.toThrow();
	});
});

describe('assertTxSizeWithinLimit', () => {
	it('does not throw for an empty tx hex', () => {
		expect(() => assertTxSizeWithinLimit('', 'label')).not.toThrow();
	});

	it('does not throw exactly at the limit', () => {
		// 2 hex chars per byte; MAX_SAFE_TX_BYTES bytes = 2 * MAX_SAFE_TX_BYTES chars.
		const hex = '0'.repeat(MAX_SAFE_TX_BYTES * 2);
		expect(() => assertTxSizeWithinLimit(hex, 'label')).not.toThrow();
	});

	it('throws one byte over the limit', () => {
		const hex = '0'.repeat((MAX_SAFE_TX_BYTES + 1) * 2);
		expect(() => assertTxSizeWithinLimit(hex, 'batch-mint')).toThrow(/batch-mint/);
		expect(() => assertTxSizeWithinLimit(hex, 'batch-mint')).toThrow(new RegExp(String(MAX_SAFE_TX_BYTES)));
	});

	it('includes the label and the actual size in the error message', () => {
		const overBytes = MAX_SAFE_TX_BYTES + 100;
		const hex = '0'.repeat(overBytes * 2);
		expect(() => assertTxSizeWithinLimit(hex, 'my-label')).toThrow(new RegExp(String(overBytes)));
		expect(() => assertTxSizeWithinLimit(hex, 'my-label')).toThrow(/my-label/);
	});

	it('exports MAX_SAFE_TX_BYTES as 14_000', () => {
		expect(MAX_SAFE_TX_BYTES).toBe(14_000);
	});
});

describe('isTxSizeWithinLimit', () => {
	it('returns true for an empty tx hex', () => {
		expect(isTxSizeWithinLimit('')).toBe(true);
	});

	it('returns true exactly at the limit', () => {
		const hex = '0'.repeat(MAX_SAFE_TX_BYTES * 2);
		expect(isTxSizeWithinLimit(hex)).toBe(true);
	});

	it('returns false one byte over the limit', () => {
		const hex = '0'.repeat((MAX_SAFE_TX_BYTES + 1) * 2);
		expect(isTxSizeWithinLimit(hex)).toBe(false);
	});

	it('agrees with assertTxSizeWithinLimit at the boundary', () => {
		const atLimit = '0'.repeat(MAX_SAFE_TX_BYTES * 2);
		const overLimit = '0'.repeat((MAX_SAFE_TX_BYTES + 1) * 2);
		expect(isTxSizeWithinLimit(atLimit)).toBe(true);
		expect(() => assertTxSizeWithinLimit(atLimit, 'label')).not.toThrow();
		expect(isTxSizeWithinLimit(overLimit)).toBe(false);
		expect(() => assertTxSizeWithinLimit(overLimit, 'label')).toThrow();
	});
});
