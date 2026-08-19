import { describe, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import { assertCommitDraftInputsAreNodeFunded, HydraCommitInputSafetyError } from './commit-input-safety';

const WALLET_KEY = 'aa'.repeat(28);
const NODE_KEY = 'bb'.repeat(28);
const COMMIT_HASH = '11'.repeat(32);
const NODE_HASH = '22'.repeat(32);
const WALLET_EXTRA_HASH = '33'.repeat(32);

function output(paymentKeyHash: string): UTxO['output'] {
	// A minimal enterprise address whose payment credential resolves to the given
	// key hash — the test stubs paymentKeyHashOf, so the string only needs to be
	// distinct and round-trip through the stub.
	return { address: `addr::${paymentKeyHash}`, amount: [{ unit: 'lovelace', quantity: '1000000' }] };
}

const paymentKeyHashOf = (address: string) => address.split('::')[1];

function resolverFrom(map: Record<string, string>) {
	return async (txHash: string, index: number) => {
		const key = `${txHash}#${index}`;
		return key in map ? output(map[key]) : null;
	};
}

describe('assertCommitDraftInputsAreNodeFunded', () => {
	const base = {
		commitReferences: [`${COMMIT_HASH}#0`],
		walletPaymentKeyHash: WALLET_KEY,
		paymentKeyHashOf,
	};

	it('accepts a draft whose only wallet inputs are the committed UTxOs', async () => {
		await expect(
			assertCommitDraftInputsAreNodeFunded({
				...base,
				inputReferences: [`${COMMIT_HASH}#0`, `${NODE_HASH}#0`],
				collateralReferences: [`${NODE_HASH}#1`],
				resolveOutput: resolverFrom({ [`${NODE_HASH}#0`]: NODE_KEY, [`${NODE_HASH}#1`]: NODE_KEY }),
			}),
		).resolves.toBeUndefined();
	});

	it('rejects a non-committed input owned by the wallet key', async () => {
		await expect(
			assertCommitDraftInputsAreNodeFunded({
				...base,
				inputReferences: [`${COMMIT_HASH}#0`, `${WALLET_EXTRA_HASH}#0`],
				collateralReferences: [],
				resolveOutput: resolverFrom({ [`${WALLET_EXTRA_HASH}#0`]: WALLET_KEY }),
			}),
		).rejects.toThrow(HydraCommitInputSafetyError);
	});

	it('rejects a wallet-key-owned collateral input', async () => {
		const promise = assertCommitDraftInputsAreNodeFunded({
			...base,
			inputReferences: [`${COMMIT_HASH}#0`, `${NODE_HASH}#0`],
			collateralReferences: [`${WALLET_EXTRA_HASH}#0`],
			resolveOutput: resolverFrom({ [`${NODE_HASH}#0`]: NODE_KEY, [`${WALLET_EXTRA_HASH}#0`]: WALLET_KEY }),
		});
		await expect(promise).rejects.toMatchObject({ reason: 'wallet-owned' });
	});

	it('fails closed when a non-committed input cannot be resolved', async () => {
		const promise = assertCommitDraftInputsAreNodeFunded({
			...base,
			inputReferences: [`${COMMIT_HASH}#0`, `${NODE_HASH}#0`],
			collateralReferences: [],
			resolveOutput: resolverFrom({}),
		});
		await expect(promise).rejects.toMatchObject({ reason: 'unresolved' });
	});

	it('fails closed when the resolver throws', async () => {
		const promise = assertCommitDraftInputsAreNodeFunded({
			...base,
			inputReferences: [`${COMMIT_HASH}#0`, `${NODE_HASH}#0`],
			collateralReferences: [],
			resolveOutput: async () => {
				throw new Error('blockfrost timeout');
			},
		});
		await expect(promise).rejects.toMatchObject({ reason: 'unresolved' });
	});

	it('never resolves committed inputs (no wasted lookups)', async () => {
		const resolveOutput = jest.fn(resolverFrom({ [`${NODE_HASH}#0`]: NODE_KEY }));
		await assertCommitDraftInputsAreNodeFunded({
			...base,
			inputReferences: [`${COMMIT_HASH}#0`, `${NODE_HASH}#0`],
			collateralReferences: [],
			resolveOutput,
		});
		expect(resolveOutput).toHaveBeenCalledTimes(1);
		expect(resolveOutput).toHaveBeenCalledWith(NODE_HASH, 0);
	});

	it('matches references case-insensitively so commits are not double-checked', async () => {
		const resolveOutput = jest.fn(resolverFrom({}));
		await assertCommitDraftInputsAreNodeFunded({
			...base,
			commitReferences: [`${COMMIT_HASH.toUpperCase()}#0`],
			inputReferences: [`${COMMIT_HASH}#0`],
			collateralReferences: [],
			resolveOutput,
		});
		expect(resolveOutput).not.toHaveBeenCalled();
	});
});
