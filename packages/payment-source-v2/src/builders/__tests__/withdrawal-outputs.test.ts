import { MeshTxBuilder, mOutputReference, DEFAULT_PROTOCOL_PARAMETERS, type Output } from '@meshsdk/core';
import { addMinimumAdaOutput, addWithdrawalOutputs } from '../withdrawal-outputs';

const address =
	'addr1qxk6pvm8uufjvmwappnl4s7zu7t0ql6rx9wnzl3e4x0zuqdcgnhgarwqwzera5canfysuau8z4rtd7exc0qrul4hcm5s5l8xwx';
const ref = { txHash: 'f7235d7ce327cf6cf0b288af77502650e6843c81b52c23c7aff8e99be9122773', outputIndex: 0 };
const assets = [
	{ unit: 'lovelace', quantity: '34480' },
	{ unit: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d', quantity: '900000' },
];

function outputs(builder: MeshTxBuilder) {
	builder.txOut(address, []); // Flush the final explicit output into the body.
	return builder.meshTxBuilderBody.outputs;
}

it('funds the rejected USDM withdrawal to its serialized minimum without mutating input assets', () => {
	const builder = new MeshTxBuilder({ isHydra: true });
	addWithdrawalOutputs(
		builder,
		{ coinsPerUtxoSize: 4310 },
		ref,
		{ collectionAddress: address, collectAssets: assets },
		null,
		null,
	);
	const [output] = outputs(builder);
	expect(output.amount).toEqual([{ unit: 'lovelace', quantity: '1379200' }, assets[1]]);
	expect(assets[0].quantity).toBe('34480');
	expect(output.datum?.data.content).toEqual(mOutputReference(ref.txHash, 0));
});

it('tops up collection, fee and collateral return outputs and preserves larger balances', () => {
	const builder = new MeshTxBuilder();
	addWithdrawalOutputs(
		builder,
		{ coinsPerUtxoSize: 4310 },
		ref,
		{ collectionAddress: address, collectAssets: [{ unit: 'lovelace', quantity: '5000000' }] },
		{ feeAddress: address, feeAssets: [{ unit: 'lovelace', quantity: '1' }] },
		{ address, lovelace: 1n },
	);
	const result = outputs(builder);
	expect(result[0].amount[0].quantity).toBe('5000000');
	for (const output of result.slice(1)) expect(BigInt(output.amount[0].quantity)).toBeGreaterThan(1000000n);
});

it.each([0, 4310, 8620])('uses the supplied head byte cost %i, including missing ADA', (cost) => {
	const builder = new MeshTxBuilder();
	const output: Output = { address, amount: [assets[1]] };
	addMinimumAdaOutput(builder, output, cost);
	const [result] = outputs(builder);
	const ada = BigInt(result.amount.find((a) => a.unit === 'lovelace')!.quantity);
	expect(ada).toBeGreaterThanOrEqual(BigInt(cost) * 250n);
	if (cost === 0) expect(ada).toBe(0n);
	expect(output.amount).toEqual([assets[1]]);
});

it.each([true, false])('completed Hydra payout requires wallet funding: %s', async (funded) => {
	const builder = new MeshTxBuilder({ isHydra: true });
	builder.protocolParams({ ...DEFAULT_PROTOCOL_PARAMETERS, coinsPerUtxoSize: 4310 });
	builder.setFee('0');
	builder.txIn(ref.txHash, 0, assets, address, 0);
	builder.setNetwork('mainnet');
	addWithdrawalOutputs(
		builder,
		{ coinsPerUtxoSize: 4310 },
		ref,
		{ collectionAddress: address, collectAssets: assets },
		null,
		null,
	);
	builder.selectUtxosFrom(
		funded
			? [
					{
						input: { txHash: 'aa'.repeat(32), outputIndex: 0 },
						output: { address, amount: [{ unit: 'lovelace', quantity: '5000000' }] },
					},
				]
			: [],
	);
	builder.changeAddress(address);
	if (!funded) {
		await expect(builder.complete()).rejects.toThrow(/UTxO|fund|balance|input/i);
		return;
	}
	await expect(builder.complete()).resolves.toMatch(/^[0-9a-f]+$/);
	expect(builder.meshTxBuilderBody.inputs.length).toBe(2);
	expect(builder.meshTxBuilderBody.outputs[0].amount).toContainEqual({ unit: 'lovelace', quantity: '1379200' });
});
