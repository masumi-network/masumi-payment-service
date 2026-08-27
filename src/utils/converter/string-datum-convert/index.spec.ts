import { byteString, conStr0, conStr1, integer, pubKeyAddress, serializeAddressObj } from '@meshsdk/core';
import { decodeV2ContractDatum, newCooldownTime } from './index';

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
