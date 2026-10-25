import { SmartContractState } from '@masumi/payment-core';
import { getDatumV2 } from './contract-generator';
import { fromBuilderToPlutusData } from '@meshsdk/core-cst';
import type { Data } from '@meshsdk/core';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { createDatumFromDecodedContractV2 } from './datum-builder';
import {
	Address,
	BaseAddress,
	BigNum,
	Credential,
	Ed25519KeyHash,
	EnterpriseAddress,
	PlutusData,
	PlutusDatumSchema,
	Pointer,
	PointerAddress,
	ScriptHash,
} from '@emurgo/cardano-serialization-lib-nodejs';

const PREPROD_BASE_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
// Same payment key hash as PREPROD_BASE_ADDRESS, no stake credential.
const PREPROD_ENTERPRISE_ADDRESS = 'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu';
const PREPROD_SCRIPT_ADDRESS = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';
const PAYMENT_KEY_HASH = '1f9d349ec66fb28920e0f093edce415792ce0281a8825015ce3e16bf';

type MConstr = { alternative: number; fields: unknown[] };

function buildDatum(
	overrides: {
		buyerAddress?: string;
		sellerAddress?: string;
		buyerReturnAddress?: string;
		sellerReturnAddress?: string;
	} = {},
) {
	return getDatumV2({
		buyerAddress: overrides.buyerAddress ?? PREPROD_BASE_ADDRESS,
		sellerAddress: overrides.sellerAddress ?? PREPROD_BASE_ADDRESS,
		buyerReturnAddress: overrides.buyerReturnAddress,
		sellerReturnAddress: overrides.sellerReturnAddress,
		referenceKey: 'aa'.repeat(32),
		referenceSignature: 'bb'.repeat(16),
		sellerNonce: 'cc'.repeat(32),
		buyerNonce: 'dd'.repeat(32),
		agentIdentifier: 'ee'.repeat(16),
		collateralReturnLovelace: 0n,
		inputHash: null,
		resultHash: null,
		payByTime: 1_000n,
		resultTime: 2_000n,
		unlockTime: 3_000n,
		externalDisputeUnlockTime: 4_000n,
		newCooldownTimeSeller: 0n,
		newCooldownTimeBuyer: 0n,
		state: SmartContractState.FundsLocked,
	});
}

function addressField(datum: ReturnType<typeof buildDatum>, index: number): MConstr {
	return (datum.value as unknown as MConstr).fields[index] as MConstr;
}

describe('getDatumV2 participant address encoding', () => {
	it('encodes a base address with an inline stake credential (Some)', () => {
		const buyer = addressField(buildDatum(), 0);
		expect(buyer.alternative).toBe(0);
		const payment = buyer.fields[0] as MConstr;
		expect(payment.alternative).toBe(0);
		expect(payment.fields[0]).toBe(PAYMENT_KEY_HASH);
		const stakeOption = buyer.fields[1] as MConstr;
		expect(stakeOption.alternative).toBe(0); // Some(Inline(cred))
		expect(stakeOption.fields).toHaveLength(1);
	});

	it('encodes an enterprise address with stake credential None', () => {
		const buyer = addressField(buildDatum({ buyerAddress: PREPROD_ENTERPRISE_ADDRESS }), 0);
		expect(buyer.alternative).toBe(0);
		const payment = buyer.fields[0] as MConstr;
		expect(payment.fields[0]).toBe(PAYMENT_KEY_HASH);
		const stakeOption = buyer.fields[1] as MConstr;
		expect(stakeOption.alternative).toBe(1); // None
		expect(stakeOption.fields).toHaveLength(0);
	});

	it('accepts an enterprise seller as well', () => {
		const seller = addressField(buildDatum({ sellerAddress: PREPROD_ENTERPRISE_ADDRESS }), 2);
		const stakeOption = seller.fields[1] as MConstr;
		expect(stakeOption.alternative).toBe(1);
	});

	it('rejects script-credential participant addresses', () => {
		expect(() => buildDatum({ buyerAddress: PREPROD_SCRIPT_ADDRESS })).toThrow(
			'buyerAddress must be a Cardano base or enterprise address with a payment key credential',
		);
		expect(() => buildDatum({ sellerAddress: PREPROD_SCRIPT_ADDRESS })).toThrow(
			'sellerAddress must be a Cardano base or enterprise address with a payment key credential',
		);
	});
});

const RETURN_PAYMENT_HASH = 'aa'.repeat(28);
const RETURN_STAKE_HASH = 'bb'.repeat(28);

function addressFixture(networkId: 0 | 1, scriptPayment: boolean, staking: 'none' | 'key' | 'script' | 'pointer') {
	const payment = scriptPayment
		? Credential.from_scripthash(ScriptHash.from_hex(RETURN_PAYMENT_HASH))
		: Credential.from_keyhash(Ed25519KeyHash.from_hex(RETURN_PAYMENT_HASH));
	const credential = { constructor: scriptPayment ? 1 : 0, fields: [{ bytes: RETURN_PAYMENT_HASH }] };
	if (staking === 'none') {
		return {
			address: EnterpriseAddress.new(networkId, payment).to_address().to_bech32(),
			json: { constructor: 0, fields: [credential, { constructor: 1, fields: [] }] },
		};
	}
	if (staking === 'pointer') {
		return {
			address: PointerAddress.new(
				networkId,
				payment,
				Pointer.new_pointer(BigNum.zero(), BigNum.from_str('65535'), BigNum.zero()),
			)
				.to_address()
				.to_bech32(),
			json: {
				constructor: 0,
				fields: [
					credential,
					{ constructor: 0, fields: [{ constructor: 1, fields: [{ int: 0 }, { int: 65535 }, { int: 0 }] }] },
				],
			},
		};
	}
	const stake =
		staking === 'script'
			? Credential.from_scripthash(ScriptHash.from_hex(RETURN_STAKE_HASH))
			: Credential.from_keyhash(Ed25519KeyHash.from_hex(RETURN_STAKE_HASH));
	return {
		address: BaseAddress.new(networkId, payment, stake).to_address().to_bech32(),
		json: {
			constructor: 0,
			fields: [
				credential,
				{
					constructor: 0,
					fields: [
						{
							constructor: 0,
							fields: [{ constructor: staking === 'script' ? 1 : 0, fields: [{ bytes: RETURN_STAKE_HASH }] }],
						},
					],
				},
			],
		},
	};
}

/** Decode the schema with native CSL, independent of the builder's Mesh representation. */
function addressFromDatum(cbor: string, networkId: 0 | 1): string {
	const fields = PlutusData.from_hex(cbor).as_constr_plutus_data()!.data();
	const readCredential = (data: PlutusData) => {
		const constructor = data.as_constr_plutus_data()!;
		const hash = Buffer.from(constructor.data().get(0).as_bytes()!).toString('hex');
		return constructor.alternative().to_str() === '0'
			? Credential.from_keyhash(Ed25519KeyHash.from_hex(hash))
			: Credential.from_scripthash(ScriptHash.from_hex(hash));
	};
	const payment = readCredential(fields.get(0));
	const option = fields.get(1).as_constr_plutus_data()!;
	if (option.alternative().to_str() === '1') return EnterpriseAddress.new(networkId, payment).to_address().to_bech32();
	const staking = option.data().get(0).as_constr_plutus_data()!;
	if (staking.alternative().to_str() === '0') {
		return BaseAddress.new(networkId, payment, readCredential(staking.data().get(0)))
			.to_address()
			.to_bech32();
	}
	const components = Array.from({ length: 3 }, (_unused, index) =>
		BigNum.from_str(staking.data().get(index).as_integer()!.to_str()),
	);
	return PointerAddress.new(networkId, payment, Pointer.new_pointer(components[0], components[1], components[2]))
		.to_address()
		.to_bech32();
}

describe.each([0, 1] as const)('V2 return address CBOR on network %s', (networkId) => {
	describe.each([false, true])('script payment credential %s', (scriptPayment) => {
		it.each(['none', 'key', 'script', 'pointer'] as const)(
			'preserves %s staking credentials for both returns',
			(staking) => {
				const fixture = addressFixture(networkId, scriptPayment, staking);
				const expected = PlutusData.from_json(JSON.stringify(fixture.json), PlutusDatumSchema.DetailedSchema).to_hex();
				const datum = buildDatum({ buyerReturnAddress: fixture.address, sellerReturnAddress: fixture.address });
				for (const index of [1, 3]) {
					const option = addressField(datum, index);
					expect(option.alternative).toBe(0);
					const cbor = fromBuilderToPlutusData({ type: 'Mesh', content: option.fields[0] as Data }).toCbor();
					expect(cbor).toBe(expected);
					expect(addressFromDatum(cbor, networkId)).toBe(fixture.address);
				}
			},
		);
	});

	it('preserves script staking for verification-key principals', () => {
		const fixture = addressFixture(networkId, false, 'script');
		const datum = buildDatum({ buyerAddress: fixture.address, sellerAddress: fixture.address });
		for (const index of [0, 2]) {
			const cbor = fromBuilderToPlutusData({ type: 'Mesh', content: addressField(datum, index) as Data }).toCbor();
			expect(addressFromDatum(cbor, networkId)).toBe(fixture.address);
		}
	});

	it.each([
		['script staking', false, 'script'],
		['key payment with pointer staking', false, 'pointer'],
		['script payment with pointer staking', true, 'pointer'],
	] as const)('rebuilds an accepted %s return address for a result continuation', (_label, scriptPayment, staking) => {
		const fixture = addressFixture(networkId, scriptPayment, staking);
		const initial = buildDatum({ buyerReturnAddress: fixture.address, sellerReturnAddress: fixture.address });
		const cbor = fromBuilderToPlutusData({ type: 'Mesh', content: initial.value }).toCbor();
		const decoded = decodeV2ContractDatum(
			JSON.parse(PlutusData.from_hex(cbor).to_json(PlutusDatumSchema.DetailedSchema)),
			networkId === 1 ? 'mainnet' : 'preprod',
		);
		expect(decoded).not.toBeNull();
		expect(decoded?.buyerReturnAddress).toBe(fixture.address);
		expect(decoded?.sellerReturnAddress).toBe(fixture.address);
		const continuation = createDatumFromDecodedContractV2({
			decodedContract: decoded!,
			blockchainIdentifier: decoded!.blockchainIdentifier,
			resultHash: 'ab'.repeat(32),
			newCooldownTimeBuyer: 0n,
			newCooldownTimeSeller: 0n,
			state: SmartContractState.ResultSubmitted,
		});
		for (const index of [1, 3]) {
			const option = addressField(continuation, index);
			const addressCbor = fromBuilderToPlutusData({ type: 'Mesh', content: option.fields[0] as Data }).toCbor();
			expect(addressFromDatum(addressCbor, networkId)).toBe(fixture.address);
		}
	});

	it('rejects a pointer address that CSL normalizes to a different address', () => {
		const address = PointerAddress.new(
			networkId,
			Credential.from_keyhash(Ed25519KeyHash.from_hex(RETURN_PAYMENT_HASH)),
			Pointer.new_pointer(BigNum.zero(), BigNum.from_str('65536'), BigNum.zero()),
		)
			.to_address()
			.to_bech32();
		expect(Address.from_bech32(address).to_bech32()).not.toBe(address);
		expect(() => buildDatum({ buyerReturnAddress: address })).toThrow(/round-trip/);
		expect(() => buildDatum({ sellerReturnAddress: address })).toThrow(/round-trip/);
	});

	it.each(['none', 'key', 'script', 'pointer'] as const)('refuses script-payment %s principals', (staking) => {
		const fixture = addressFixture(networkId, true, staking);
		expect(() => buildDatum({ buyerAddress: fixture.address })).toThrow(/buyerAddress.*payment key credential/);
		expect(() => buildDatum({ sellerAddress: fixture.address })).toThrow(/sellerAddress.*payment key credential/);
	});
});
