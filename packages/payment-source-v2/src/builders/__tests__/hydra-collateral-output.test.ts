import { DEFAULT_PROTOCOL_PARAMETERS, MeshTxBuilder, getOutputMinLovelace } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';

const address =
	'addr1qxk6pvm8uufjvmwappnl4s7zu7t0ql6rx9wnzl3e4x0zuqdcgnhgarwqwzera5canfysuau8z4rtd7exc0qrul4hcm5s5l8xwx';
const tokens = Array.from({ length: 8 }, (_, i) => ({
	unit: (i + 1).toString(16).padStart(2, '0').repeat(28) + 'ab'.repeat(32),
	quantity: '1',
}));
it('zero-fee Hydra returns all mixed collateral in a valid output', async () => {
	const builder = new MeshTxBuilder({ isHydra: true });
	builder.protocolParams({ ...DEFAULT_PROTOCOL_PARAMETERS, coinsPerUtxoSize: 4310 });
	const collateral = [{ unit: 'lovelace', quantity: '5000000' }, ...tokens];
	const amount = [{ unit: 'lovelace', quantity: '10000000' }];
	builder
		.txIn('aa'.repeat(32), 0, [{ unit: 'lovelace', quantity: '15000000' }], address, 0)
		.txInCollateral('bb'.repeat(32), 0, collateral, address)
		.setTotalCollateral('0')
		.txOut(address, amount)
		.setFee('0')
		.changeAddress(address)
		.setNetwork('mainnet');
	const tx = await builder.complete();
	const body = deserializeTx(tx).body();
	const returned = body.collateralReturn();
	expect(returned).toBeDefined();
	expect(body.totalCollateral()).toBe(0n);
	expect(returned!.amount().coin()).toBe(5000000n);
	expect(returned!.amount().coin()).toBeGreaterThanOrEqual(getOutputMinLovelace({ address, amount: collateral }, 4310));
	expect(body.fee()).toBe(0n);
});
