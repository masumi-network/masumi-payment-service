import {
	byteString,
	conStr0,
	conStr1,
	integer,
	pubKeyAddress,
	scriptAddress,
	serializeAddressObj,
} from '@meshsdk/core';
import { Address, PointerAddress } from '@emurgo/cardano-serialization-lib-nodejs';
import { decodeV1ContractDatum, decodeV2ContractDatum, newCooldownTime } from './index';

const BUYER_PKH = 'aa'.repeat(28);
const SELLER_PKH = 'bb'.repeat(28);
const OTHER_PKH = 'cc'.repeat(28);
const STAKE_KH = 'dd'.repeat(28);

type AddressData = ReturnType<typeof pubKeyAddress>;

type Numbers = {
	collateralReturnLovelace?: bigint | number;
	payByTime?: bigint | number;
	submitResultTime?: bigint | number;
	unlockTime?: bigint | number;
	externalDisputeUnlockTime?: bigint | number;
	sellerCooldownTime?: bigint | number;
	buyerCooldownTime?: bigint | number;
};

function v2Datum({
	buyerReturn,
	sellerReturn,
	numbers = {},
}: { buyerReturn?: AddressData; sellerReturn?: AddressData; numbers?: Numbers } = {}) {
	return conStr0([
		pubKeyAddress(BUYER_PKH, STAKE_KH),
		buyerReturn ? conStr0([buyerReturn]) : conStr1([]),
		pubKeyAddress(SELLER_PKH, STAKE_KH),
		sellerReturn ? conStr0([sellerReturn]) : conStr1([]),
		byteString('01'.repeat(16)), // referenceKey
		byteString('02'.repeat(16)), // referenceSignature
		byteString('03'.repeat(32)), // sellerNonce
		byteString('04'.repeat(16)), // buyerNonce
		byteString('05'.repeat(16)), // agentIdentifier
		integer(numbers.collateralReturnLovelace ?? 0), // collateralReturnLovelace
		byteString(''), // inputHash
		byteString(''), // resultHash
		integer(numbers.payByTime ?? 1), // payByTime
		integer(numbers.submitResultTime ?? 2), // submitResultTime
		integer(numbers.unlockTime ?? 3), // unlockTime
		integer(numbers.externalDisputeUnlockTime ?? 4), // externalDisputeUnlockTime
		integer(numbers.sellerCooldownTime ?? 0), // sellerCooldownTime
		integer(numbers.buyerCooldownTime ?? 0), // buyerCooldownTime
		conStr0([]), // state = FundsLocked
	]);
}

/** One past what a Postgres `int8` can hold. Plutus has no such bound. */
const TOO_LARGE = 2n ** 63n;

const CONTRACT_ADDRESS = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';

describe('decodeV2ContractDatum', () => {
	describe.each([
		['buyer', 1],
		['seller', 3],
	] as const)('%s return address', (_side, index) => {
		const address = pubKeyAddress(OTHER_PKH, STAKE_KH);
		it.each([
			['empty Some', conStr0([])],
			['None with an address', conStr1([address])],
			['Some with two addresses', conStr0([address, address])],
			['unknown constructor', { constructor: 2, fields: [address] }],
			['list instead of Option', []],
			['missing Option', null],
			['missing fields', { constructor: 1 }],
			['array-like fields', { constructor: 0, fields: { 0: address, length: 1 } }],
			['string constructor', { constructor: '0', fields: [address] }],
		])('rejects %s', (_label, option) => {
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = option;
			expect(decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS)).toBeNull();
		});

		it('rejects a Some address carrying fields in its staking None', () => {
			const malformedAddress = conStr0([conStr0([byteString(OTHER_PKH)]), conStr1([byteString(STAKE_KH)])]);
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = conStr0([malformedAddress]);
			expect(decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS)).toBeNull();
		});

		it.each([2, 2n])('rejects unknown inline staking credential constructor %s', (constructor) => {
			const malformedAddress = conStr0([
				conStr0([byteString(OTHER_PKH)]),
				conStr0([conStr0([{ constructor, fields: [byteString(STAKE_KH)] }])]),
			]);
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = conStr0([malformedAddress]);
			expect(decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS)).toBeNull();
		});

		it('preserves canonical Some with no staking credential', () => {
			const enterpriseAddress = pubKeyAddress(OTHER_PKH);
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = conStr0([enterpriseAddress]);
			const decoded = decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS);
			expect(decoded).not.toBeNull();
			expect(index === 1 ? decoded?.buyerReturnAddress : decoded?.sellerReturnAddress).toBe(
				serializeAddressObj(enterpriseAddress, 0),
			);
		});

		it.each(['preprod', 'mainnet'] as const)('preserves canonical Some with script staking on %s', (network) => {
			const scriptStakeAddress = pubKeyAddress(OTHER_PKH, STAKE_KH, true);
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = conStr0([scriptStakeAddress]);
			const decoded = decodeV2ContractDatum(datum, network, CONTRACT_ADDRESS);
			expect(decoded).not.toBeNull();
			expect(index === 1 ? decoded?.buyerReturnAddress : decoded?.sellerReturnAddress).toBe(
				serializeAddressObj(scriptStakeAddress, network === 'mainnet' ? 1 : 0),
			);
		});

		it.each([false, true])('preserves supported pointer return addresses with script payment %s', (scriptPayment) => {
			const payment = scriptPayment ? conStr1([byteString(OTHER_PKH)]) : conStr0([byteString(OTHER_PKH)]);
			const pointerAddress = conStr0([payment, conStr0([conStr1([integer(0n), integer(65_535n), integer(0n)])])]);
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = conStr0([pointerAddress]);
			const decoded = decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS);
			expect(decoded).not.toBeNull();
			const address = index === 1 ? decoded?.buyerReturnAddress : decoded?.sellerReturnAddress;
			const pointer = PointerAddress.from_address(Address.from_bech32(address!))!;
			expect(pointer.stake_pointer().tx_index_bignum().to_str()).toBe('65535');
			expect(pointer.stake_pointer().slot_bignum().to_str()).toBe('0');
			expect(pointer.stake_pointer().cert_index_bignum().to_str()).toBe('0');
			expect(
				scriptPayment
					? pointer.payment_cred().to_scripthash()?.to_hex()
					: pointer.payment_cred().to_keyhash()?.to_hex(),
			).toBe(OTHER_PKH);
		});

		it.each([
			['enterprise', scriptAddress(OTHER_PKH)],
			['base', scriptAddress(OTHER_PKH, STAKE_KH)],
		] as const)('preserves script payment credentials on %s return addresses', (_shape, address) => {
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = conStr0([address]);
			const decoded = decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS);
			expect(decoded).not.toBeNull();
			expect(index === 1 ? decoded?.buyerReturnAddress : decoded?.sellerReturnAddress).toBe(
				serializeAddressObj(address, 0),
			);
		});

		it('accepts canonical bigint Option constructors', () => {
			const datum = v2Datum();
			(datum.fields as unknown[])[index] = { constructor: 0n, fields: [address] };
			expect(decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS)).not.toBeNull();
			(datum.fields as unknown[])[index] = { constructor: 1n, fields: [] };
			const decoded = decodeV2ContractDatum(datum, 'preprod', CONTRACT_ADDRESS);
			expect(decoded).not.toBeNull();
			expect(index === 1 ? decoded?.buyerReturnAddress : decoded?.sellerReturnAddress).toBeNull();
		});
	});

	it('decodes a well-formed datum', () => {
		const decoded = decodeV2ContractDatum(v2Datum(), 'preprod', CONTRACT_ADDRESS);
		expect(decoded).not.toBeNull();
		expect(decoded?.buyerReturnAddress).toBeNull();
		expect(decoded?.sellerReturnAddress).toBeNull();
	});

	it('decodes a datum with distinct return addresses', () => {
		const decoded = decodeV2ContractDatum(
			v2Datum({ buyerReturn: pubKeyAddress(OTHER_PKH, STAKE_KH) }),
			'preprod',
			CONTRACT_ADDRESS,
		);
		expect(decoded).not.toBeNull();
		expect(decoded?.buyerReturnAddress).toEqual(serializeAddressObj(pubKeyAddress(OTHER_PKH, STAKE_KH), 0));
	});

	it('rejects a datum whose buyer return address equals the contract address', () => {
		// A return address equal to the escrow script address bricks every payout
		// path on-chain (the tagged payout output would land at the script address
		// and fail the validator's strict continuation-datum parsing). The decoder
		// must flag such a lock as invalid so the seller never works against it.
		const poisoned = pubKeyAddress(OTHER_PKH, STAKE_KH);
		const poisonedAddress = serializeAddressObj(poisoned, 0);
		const decoded = decodeV2ContractDatum(v2Datum({ buyerReturn: poisoned }), 'preprod', poisonedAddress);
		expect(decoded).toBeNull();
	});

	/**
	 * Every numeric datum field is written to a Postgres `int8`, and nothing on
	 * chain bounds a Plutus integer from above: `vested_pay.ak` compares cooldowns
	 * with `>=`, which a huge value satisfies, and so does this service's own
	 * authorized-actor guard. So a counterparty could put 2^64 in a cooldown, have
	 * the head confirm the transaction, and leave Prisma refusing the write.
	 *
	 * On L1 that is one failed write. Inside a head it is permanent: the write
	 * happens in the ordered replay, the throw is caught per head and the cursor
	 * never advances, so the same transaction is retried on every tick and on
	 * every reconnect, no escrow on that head moves again, and the funds are
	 * inside it.
	 */
	it.each([
		'collateralReturnLovelace',
		'payByTime',
		'submitResultTime',
		'unlockTime',
		'externalDisputeUnlockTime',
		'sellerCooldownTime',
		'buyerCooldownTime',
	] as const)('rejects a datum whose %s does not fit the column it is stored in', (field) => {
		expect(decodeV2ContractDatum(v2Datum({ numbers: { [field]: TOO_LARGE } }), 'preprod', CONTRACT_ADDRESS)).toBeNull();
	});

	it('still accepts the largest value that does fit', () => {
		expect(
			decodeV2ContractDatum(v2Datum({ numbers: { payByTime: TOO_LARGE - 1n } }), 'preprod', CONTRACT_ADDRESS),
		).not.toBeNull();
	});

	it('rejects a datum whose seller return address equals the contract address', () => {
		const poisoned = pubKeyAddress(OTHER_PKH, STAKE_KH);
		const poisonedAddress = serializeAddressObj(poisoned, 0);
		const decoded = decodeV2ContractDatum(v2Datum({ sellerReturn: poisoned }), 'preprod', poisonedAddress);
		expect(decoded).toBeNull();
	});

	it('does not reject when no contract address is provided', () => {
		const decoded = decodeV2ContractDatum(
			v2Datum({ buyerReturn: pubKeyAddress(OTHER_PKH, STAKE_KH) }),
			'preprod',
			null,
		);
		expect(decoded).not.toBeNull();
	});
});

describe.each(['V1', 'V2'] as const)('%s principal address validation', (version) => {
	function decodePrincipal(address: unknown, side: 'buyer' | 'seller', network: 'preprod' | 'mainnet' = 'preprod') {
		const datum = v2Datum();
		(datum.fields as unknown[])[side === 'buyer' ? 0 : 2] = address;
		if (version === 'V2') return decodeV2ContractDatum(datum, network);
		const { fields } = datum;
		return decodeV1ContractDatum(conStr0([fields[0], fields[2], ...fields.slice(4, 8), ...fields.slice(9)]), network);
	}

	describe.each(['buyer', 'seller'] as const)('%s signing authority', (side) => {
		it.each([
			['enterprise', scriptAddress(OTHER_PKH)],
			['base', scriptAddress(OTHER_PKH, STAKE_KH)],
			[
				'pointer',
				conStr0([conStr1([byteString(OTHER_PKH)]), conStr0([conStr1([integer(0), integer(0), integer(0)])])]),
			],
		] as const)('rejects script payment credentials on %s principals', (_shape, address) => {
			expect(decodePrincipal(address, side)).toBeNull();
		});
	});

	it.each(['buyer', 'seller'] as const)('rejects an unknown inline staking credential in the %s principal', (side) => {
		const malformedAddress = conStr0([
			conStr0([byteString(OTHER_PKH)]),
			conStr0([conStr0([{ constructor: 2, fields: [byteString(STAKE_KH)] }])]),
		]);
		expect(decodePrincipal(malformedAddress, side)).toBeNull();
	});

	it.each(['buyer', 'seller'] as const)('rejects a malformed staking None in the %s principal', (side) => {
		const malformedAddress = conStr0([conStr0([byteString(OTHER_PKH)]), conStr1([byteString(STAKE_KH)])]);
		expect(decodePrincipal(malformedAddress, side)).toBeNull();
	});

	it.each([
		['unknown Address constructor', { constructor: 1, fields: [conStr0([byteString(OTHER_PKH)]), conStr1([])] }],
		['short payment hash', conStr0([conStr0([byteString('aa')]), conStr1([])])],
		[
			'short stake hash',
			conStr0([conStr0([byteString(OTHER_PKH)]), conStr0([conStr0([conStr0([byteString('aa')])])])]),
		],
		['wrong Inline arity', conStr0([conStr0([byteString(OTHER_PKH)]), conStr0([conStr0([])])])],
		[
			'unknown StakeCredential constructor',
			conStr0([conStr0([byteString(OTHER_PKH)]), conStr0([{ constructor: 2, fields: [] }])]),
		],
		[
			'lossy pointer index',
			conStr0([conStr0([byteString(OTHER_PKH)]), conStr0([conStr1([integer(0), integer(65_536), integer(0)])])]),
		],
		[
			'unsafe numeric pointer',
			conStr0([
				conStr0([byteString(OTHER_PKH)]),
				conStr0([conStr1([integer(0), integer(9_007_199_254_740_993n), integer(0)])]),
			]),
		],
		[
			'negative pointer',
			conStr0([conStr0([byteString(OTHER_PKH)]), conStr0([conStr1([integer(-1), integer(0), integer(0)])])]),
		],
		[
			'overflowing pointer',
			conStr0([conStr0([byteString(OTHER_PKH)]), conStr0([conStr1([integer(2n ** 64n), integer(0), integer(0)])])]),
		],
	])('rejects %s without normalizing it', (_label, address) => {
		expect(decodePrincipal(address, 'buyer')).toBeNull();
	});

	it.each(['preprod', 'mainnet'] as const)('preserves script staking for both principals on %s', (network) => {
		const address = pubKeyAddress(OTHER_PKH, STAKE_KH, true);
		for (const side of ['buyer', 'seller'] as const) {
			const decoded = decodePrincipal(address, side, network);
			expect(decoded).not.toBeNull();
			expect(side === 'buyer' ? decoded?.buyerAddress : decoded?.sellerAddress).toBe(
				serializeAddressObj(address, network === 'mainnet' ? 1 : 0),
			);
		}
	});

	it.each(['preprod', 'mainnet'] as const)(
		'keeps zero and maximal supported pointer indices exact on %s',
		(network) => {
			const pointerAddress = conStr0([
				conStr0([byteString(OTHER_PKH)]),
				conStr0([conStr1([integer(0n), integer(65_535n), integer(0n)])]),
			]);
			const decoded = decodePrincipal(pointerAddress, 'buyer', network);
			expect(decoded).not.toBeNull();
			const serialized = Address.from_bech32(decoded!.buyerAddress);
			expect(serialized.network_id()).toBe(network === 'mainnet' ? 1 : 0);
			const pointer = PointerAddress.from_address(serialized)!.stake_pointer();
			expect([
				pointer.slot_bignum().to_str(),
				pointer.tx_index_bignum().to_str(),
				pointer.cert_index_bignum().to_str(),
			]).toEqual(['0', '65535', '0']);
		},
	);
});

it('preserves V1 datum decoding without optional return fields', () => {
	const { fields } = v2Datum();
	const datum = conStr0([fields[0], fields[2], ...fields.slice(4, 8), ...fields.slice(9)]);
	const decoded = decodeV1ContractDatum(datum, 'preprod');
	expect(decoded).not.toBeNull();
	expect(decoded?.buyerAddress).toBe(serializeAddressObj(pubKeyAddress(BUYER_PKH, STAKE_KH), 0));
	expect(decoded?.sellerAddress).toBe(serializeAddressObj(pubKeyAddress(SELLER_PKH, STAKE_KH), 0));
});

describe('newCooldownTime', () => {
	afterEach(() => {
		delete process.env.COOLDOWN_BLOCKTIME_BUFFER_MS;
	});

	it('adds the 10-min default blocktime buffer', () => {
		const before = BigInt(Date.now());
		const result = newCooldownTime(60_000n);
		const after = BigInt(Date.now());
		expect(result).toBeGreaterThanOrEqual(before + 60_000n + 600_000n);
		expect(result).toBeLessThanOrEqual(after + 60_000n + 600_000n);
	});

	it('honors a COOLDOWN_BLOCKTIME_BUFFER_MS override at or above the floor', () => {
		process.env.COOLDOWN_BLOCKTIME_BUFFER_MS = '480000';
		const before = BigInt(Date.now());
		const result = newCooldownTime(60_000n);
		const after = BigInt(Date.now());
		expect(result).toBeGreaterThanOrEqual(before + 60_000n + 480_000n);
		expect(result).toBeLessThanOrEqual(after + 60_000n + 480_000n);
	});

	// A minute was accepted before, and it is one the validator rejects: the
	// default tx window's upper bound already reaches 5min30s past now, and the
	// on-chain check compares against that bound. The transaction was built,
	// submitted and refused on chain.
	it('clamps an override below the on-chain minimum', () => {
		process.env.COOLDOWN_BLOCKTIME_BUFFER_MS = '60000';
		const before = BigInt(Date.now());
		const result = newCooldownTime(60_000n);
		expect(result).toBeGreaterThanOrEqual(before + 60_000n + 360_000n);
	});

	it('ignores a non-numeric override and keeps the default', () => {
		process.env.COOLDOWN_BLOCKTIME_BUFFER_MS = 'ten-minutes';
		const before = BigInt(Date.now());
		const result = newCooldownTime(0n);
		expect(result).toBeGreaterThanOrEqual(before + 600_000n);
	});
});
