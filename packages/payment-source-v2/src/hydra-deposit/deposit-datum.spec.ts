import { describe, expect, it } from '@jest/globals';
import { ConstrPlutusData, PlutusData, PlutusList, PlutusMap } from '@meshsdk/core-cst';
import { decodeCommittedOutput, DepositDatumError, parseDepositDatum } from './deposit-datum';

// Preprod deposit 4bb387c4…d0e3#0 at the hydra 2.4.1 deposit script, as Blockfrost
// returns its inline datum. It commits 6c968795…3a8e#0, which on chain is
// addr_test1qr39t805…dhh5vd holding 1159390 lovelace and 1000000 tUSDM.
const PREPROD_DEPOSIT_DATUM =
	'd8799f581c6a5b9ba16b74b39ca18e378075c6709ad7e442028e401c505f01135a1b000001a09459c3809fd8799fd8799f58206c96879502eec7ee84daedf8a8702aa96e137d5ce8ad7b1705039534fd723a8e00ff5f5840d8799fd8799fd8799f581ce2559df4629eac5176a6d585d3479551863188ee6242baf362d754c4ffd8799fd8799fd8799f581c9d5dbf261545c91c0a2bce4efd584024e420901ffbf052873b187b18cb5effffffffa240a1401a0011b0de581cc8fc35bde37cbf2a7a25bcb0be52ce7de8a60b3341b5af2fd0f7a324a145745348534d481a000f4240d87980d87a80ffffffffff';
const PREPROD_COMMITTED_ADDRESS =
	'addr_test1qr39t805v202c5tk5m2ct568j4gcvvvgae3y9whnvtt4f3yatkljv929eywq527wfm7jfepqjq0lhuzjsua3s7cced0qdhh5vd';
const TUSDM = 'c8fc35bde37cbf2a7a25bcb0be52ce7de8a60b3341b5af2fd0f7a3247453485348';

function constr(alternative: number, fields: PlutusData[]): PlutusData {
	const list = new PlutusList();
	for (const field of fields) list.add(field);
	return PlutusData.newConstrPlutusData(new ConstrPlutusData(BigInt(alternative), list));
}
const bytes = (hex: string) => PlutusData.newBytes(Buffer.from(hex, 'hex'));
const int = (value: bigint) => PlutusData.newInteger(value);
function map(pairs: Array<[PlutusData, PlutusData]>): PlutusData {
	const value = new PlutusMap();
	for (const [key, entry] of pairs) value.insert(key, entry);
	return PlutusData.newMap(value);
}
const adaValue = (lovelace: bigint) => map([[bytes(''), map([[bytes(''), int(lovelace)]])]]);
const scriptAddress = (hash: string) => constr(0, [constr(1, [bytes(hash)]), constr(1, [])]);

function txOut(fields: { address?: PlutusData; value?: PlutusData; datum?: PlutusData; script?: PlutusData }) {
	return constr(0, [
		fields.address ?? scriptAddress('ab'.repeat(28)),
		fields.value ?? adaValue(2_000_000n),
		fields.datum ?? constr(0, []),
		fields.script ?? constr(1, []),
	]).toCbor();
}

describe('parseDepositDatum', () => {
	it('reads a real preprod deposit back into the committed output', () => {
		const parsed = parseDepositDatum(PREPROD_DEPOSIT_DATUM, 0);
		expect(parsed.headId).toBe('6a5b9ba16b74b39ca18e378075c6709ad7e442028e401c505f01135a');
		expect(parsed.deadlineMs).toBe(1_789_195_305_856n);
		expect(parsed.commits).toEqual([
			{
				txHash: '6c96879502eec7ee84daedf8a8702aa96e137d5ce8ad7b1705039534fd723a8e',
				outputIndex: 0,
				output: {
					address: PREPROD_COMMITTED_ADDRESS,
					amount: [
						{ unit: 'lovelace', quantity: '1159390' },
						{ unit: TUSDM, quantity: '1000000' },
					],
					inlineDatumCbor: null,
				},
			},
		]);
	});

	it('orders commits by output reference, as the validator hashes them', () => {
		const commit = (txHash: string, index: number) =>
			constr(0, [constr(0, [bytes(txHash), int(BigInt(index))]), bytes(txOut({}))]);
		const datum = constr(0, [
			bytes('11'.repeat(28)),
			int(1n),
			PlutusData.newList(
				(() => {
					const list = new PlutusList();
					list.add(commit('bb'.repeat(32), 0));
					list.add(commit('aa'.repeat(32), 2));
					list.add(commit('aa'.repeat(32), 1));
					return list;
				})(),
			),
		]).toCbor();
		const refs = parseDepositDatum(datum, 0).commits.map((c) => `${c.txHash.slice(0, 2)}#${c.outputIndex}`);
		expect(refs).toEqual(['aa#1', 'aa#2', 'bb#0']);
	});

	it('refuses a datum that is not a deposit datum', () => {
		expect(() => parseDepositDatum(constr(1, []).toCbor(), 0)).toThrow(DepositDatumError);
		expect(() => parseDepositDatum('zz', 0)).toThrow(DepositDatumError);
	});
});

describe('decodeCommittedOutput', () => {
	it('keeps an inline datum byte for byte', () => {
		const inline = constr(0, [bytes('cafe'), int(7n)]);
		const decoded = decodeCommittedOutput(txOut({ datum: constr(2, [inline]) }), 0);
		expect(decoded.inlineDatumCbor).toBe(inline.toCbor());
		expect(decoded.address.startsWith('addr_test1w')).toBe(true);
	});

	it('builds a mainnet address for network 1', () => {
		expect(decodeCommittedOutput(txOut({}), 1).address.startsWith('addr1w')).toBe(true);
	});

	it('refuses what it cannot rebuild exactly', () => {
		expect(() => decodeCommittedOutput(txOut({ datum: constr(1, [bytes('00'.repeat(32))]) }), 0)).toThrow(/datum hash/);
		expect(() => decodeCommittedOutput(txOut({ script: constr(0, [bytes('00'.repeat(28))]) }), 0)).toThrow(
			/reference script/,
		);
		const pointer = constr(0, [
			constr(0, [bytes('ab'.repeat(28))]),
			constr(0, [constr(1, [int(1n), int(2n), int(3n)])]),
		]);
		expect(() => decodeCommittedOutput(txOut({ address: pointer }), 0)).toThrow(/stake pointer/);
		expect(() => decodeCommittedOutput(txOut({ value: map([]) }), 0)).toThrow(/no ADA/);
	});
});
