import { describe, it, expect } from '@jest/globals';
import { mapAmountToHydraValue, mapHydraValueToAmount, mapUTxOToHydraUTxO, mapHydraUTxOToUTxO } from './codec';

describe('mapAmountToHydraValue', () => {
	it('converts lovelace-only amount', () => {
		const result = mapAmountToHydraValue([{ unit: 'lovelace', quantity: '5000000' }]);
		expect(result).toEqual({ lovelace: 5000000 });
	});

	it('converts multi-asset amount', () => {
		const result = mapAmountToHydraValue([
			{ unit: 'lovelace', quantity: '2000000' },
			{ unit: 'abc123policy001tokenName', quantity: '42' },
		]);
		expect(result).toEqual({ lovelace: 2000000, abc123policy001tokenName: 42 });
	});

	it('returns empty object for empty array', () => {
		expect(mapAmountToHydraValue([])).toEqual({});
	});
});

describe('mapHydraValueToAmount', () => {
	it('converts single lovelace entry', () => {
		const result = mapHydraValueToAmount({ lovelace: 3000000 });
		expect(result).toEqual([{ unit: 'lovelace', quantity: '3000000' }]);
	});

	it('converts multi-asset value', () => {
		const result = mapHydraValueToAmount({ lovelace: 1000000, policy001token: 7 });
		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ unit: 'lovelace', quantity: '1000000' });
		expect(result).toContainEqual({ unit: 'policy001token', quantity: '7' });
	});

	it('round-trips with mapAmountToHydraValue', () => {
		const original = [
			{ unit: 'lovelace', quantity: '9000000' },
			{ unit: 'policyXXtoken', quantity: '100' },
		];
		const roundTripped = mapHydraValueToAmount(mapAmountToHydraValue(original));
		expect(roundTripped).toEqual(expect.arrayContaining(original));
		expect(roundTripped).toHaveLength(original.length);
	});
});

describe('mapUTxOToHydraUTxO', () => {
	it('maps a basic UTxO without datum', () => {
		const utxo = {
			input: { txHash: 'aaaa', outputIndex: 0 },
			output: {
				address: 'addr_test1abc',
				amount: [{ unit: 'lovelace', quantity: '5000000' }],
				dataHash: undefined,
				plutusData: undefined,
			},
		};
		const result = mapUTxOToHydraUTxO(utxo);
		expect(result).toMatchObject({
			address: 'addr_test1abc',
			value: { lovelace: 5000000 },
			datumhash: null,
			inlineDatumRaw: null,
			inlineDatum: null,
			datum: null,
			referenceScript: null,
		});
	});

	it('maps dataHash when present', () => {
		const utxo = {
			input: { txHash: 'bbbb', outputIndex: 1 },
			output: {
				address: 'addr_test1xyz',
				amount: [{ unit: 'lovelace', quantity: '2000000' }],
				dataHash: 'datahash123',
				plutusData: undefined,
			},
		};
		const result = mapUTxOToHydraUTxO(utxo);
		expect(result.datumhash).toBe('datahash123');
	});

	it('maps plutusData as inlineDatumRaw', () => {
		const utxo = {
			input: { txHash: 'cccc', outputIndex: 0 },
			output: {
				address: 'addr_test1',
				amount: [{ unit: 'lovelace', quantity: '1000000' }],
				dataHash: undefined,
				plutusData: 'd87980',
			},
		};
		const result = mapUTxOToHydraUTxO(utxo);
		expect(result.inlineDatumRaw).toBe('d87980');
	});
});

describe('mapHydraUTxOToUTxO', () => {
	const baseHydraUTxO = {
		address: 'addr_test1abc',
		value: { lovelace: 3000000 },
		datumhash: null,
		inlineDatum: null,
		inlineDatumRaw: null,
		datum: null,
		referenceScript: null,
	};

	it('parses txHash and outputIndex from txId string', () => {
		const result = mapHydraUTxOToUTxO('deadbeef#2', baseHydraUTxO);
		expect(result.input.txHash).toBe('deadbeef');
		expect(result.input.outputIndex).toBe(2);
	});

	it('maps address and amounts correctly', () => {
		const result = mapHydraUTxOToUTxO('deadbeef#0', baseHydraUTxO);
		expect(result.output.address).toBe('addr_test1abc');
		expect(result.output.amount).toEqual([{ unit: 'lovelace', quantity: '3000000' }]);
	});

	it('maps datumhash to dataHash', () => {
		const withDatum = { ...baseHydraUTxO, datumhash: 'abc123hash' };
		const result = mapHydraUTxOToUTxO('txhash#0', withDatum);
		expect(result.output.dataHash).toBe('abc123hash');
	});

	it('maps inlineDatumRaw to plutusData', () => {
		const withDatum = { ...baseHydraUTxO, inlineDatumRaw: 'd879' };
		const result = mapHydraUTxOToUTxO('txhash#0', withDatum);
		expect(result.output.plutusData).toBe('d879');
	});

	it('throws for invalid txId with no hash separator', () => {
		expect(() => mapHydraUTxOToUTxO('invalidtxid', baseHydraUTxO)).toThrow('Invalid txId: invalidtxid');
	});

	it('throws for txId missing outputIndex part', () => {
		expect(() => mapHydraUTxOToUTxO('txhashonly#', baseHydraUTxO)).toThrow();
	});
});
