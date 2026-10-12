import { describe, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import { Credential, Ed25519KeyHash, EnterpriseAddress, ScriptHash } from '@emurgo/cardano-serialization-lib-nodejs';
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

describe('assertCommitDraftInputsAreNodeFunded with refuseScriptInputs', () => {
	const enterprise = (credential: Credential) => EnterpriseAddress.new(0, credential).to_address().to_bech32();
	const NODE_ADDRESS = enterprise(Credential.from_keyhash(Ed25519KeyHash.from_hex(NODE_KEY)));
	const SCRIPT_ADDRESS = enterprise(Credential.from_scripthash(ScriptHash.from_hex('cc'.repeat(28))));
	const keyHashOf = (address: string) => (address === NODE_ADDRESS ? NODE_KEY : 'cc'.repeat(28));
	const resolveOutput = async (txHash: string): Promise<UTxO['output']> => ({
		address: txHash === NODE_HASH ? NODE_ADDRESS : SCRIPT_ADDRESS,
		amount: [{ unit: 'lovelace', quantity: '1000000' }],
	});
	const params = {
		commitReferences: [`${COMMIT_HASH}#0`],
		collateralReferences: [],
		walletPaymentKeyHash: WALLET_KEY,
		paymentKeyHashOf: keyHashOf,
		resolveOutput,
		refuseScriptInputs: true,
	};

	it('accepts node-funded key inputs', async () => {
		await expect(
			assertCommitDraftInputsAreNodeFunded({ ...params, inputReferences: [`${COMMIT_HASH}#0`, `${NODE_HASH}#0`] }),
		).resolves.toBeUndefined();
	});

	it('rejects a second script input smuggled next to the committed one', async () => {
		await expect(
			assertCommitDraftInputsAreNodeFunded({
				...params,
				inputReferences: [`${COMMIT_HASH}#0`, `${NODE_HASH}#0`, `${WALLET_EXTRA_HASH}#0`],
			}),
		).rejects.toThrow('sits at a script');
	});

	it('lets a script input through when the flag is off', async () => {
		await expect(
			assertCommitDraftInputsAreNodeFunded({
				...params,
				refuseScriptInputs: false,
				inputReferences: [`${COMMIT_HASH}#0`, `${WALLET_EXTRA_HASH}#0`],
			}),
		).resolves.toBeUndefined();
	});
});
