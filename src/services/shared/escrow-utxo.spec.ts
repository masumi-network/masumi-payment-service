import { IFetcher, UTxO } from '@meshsdk/core';
import { assertEscrowUtxoUnspent } from './escrow-utxo';

const SMART_CONTRACT_ADDRESS = 'addr_test1_contract';

function buildUtxo(txHash: string, outputIndex: number): UTxO {
	return {
		input: { txHash, outputIndex },
		output: { address: SMART_CONTRACT_ADDRESS, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
	} as UTxO;
}

function buildFetcher(liveUtxos: UTxO[]): IFetcher {
	return { fetchAddressUTxOs: () => Promise.resolve(liveUtxos) } as unknown as IFetcher;
}

describe('assertEscrowUtxoUnspent', () => {
	it('resolves when the escrow UTxO is still in the address UTxO set', async () => {
		const utxo = buildUtxo('aa', 1);
		await expect(
			assertEscrowUtxoUnspent(buildFetcher([buildUtxo('bb', 0), utxo]), SMART_CONTRACT_ADDRESS, utxo),
		).resolves.toBeUndefined();
	});

	it('throws when the escrow UTxO has already been spent', async () => {
		const utxo = buildUtxo('aa', 1);
		await expect(
			assertEscrowUtxoUnspent(buildFetcher([buildUtxo('bb', 0)]), SMART_CONTRACT_ADDRESS, utxo),
		).rejects.toThrow('already spent');
	});

	it('throws when only the output index differs', async () => {
		const utxo = buildUtxo('aa', 1);
		await expect(
			assertEscrowUtxoUnspent(buildFetcher([buildUtxo('aa', 0)]), SMART_CONTRACT_ADDRESS, utxo),
		).rejects.toThrow('already spent');
	});

	it('throws when the address has no UTxOs at all', async () => {
		const utxo = buildUtxo('aa', 1);
		await expect(assertEscrowUtxoUnspent(buildFetcher([]), SMART_CONTRACT_ADDRESS, utxo)).rejects.toThrow(
			'already spent',
		);
	});
});
