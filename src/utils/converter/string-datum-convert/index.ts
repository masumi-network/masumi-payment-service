import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@masumi/payment-core/logger';
import { serializeAddressObj } from '@meshsdk/core';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { Network } from '@meshsdk/core';

export type DecodedV1ContractDatum = {
	blockchainIdentifier: string;
	buyerAddress: string;
	buyerReturnAddress?: string | null;
	sellerAddress: string;
	sellerReturnAddress?: string | null;
	buyerVkey: string;
	sellerVkey: string;
	state: SmartContractState;
	referenceKey: string;
	referenceSignature: string;
	sellerNonce: string;
	sellerIdentifier?: string;
	buyerNonce: string;
	agentIdentifier?: string | null;
	collateralReturnLovelace: bigint;
	inputHash: string | null;
	resultHash: string | null;
	payByTime: bigint;
	resultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	buyerCooldownTime: bigint;
	sellerCooldownTime: bigint;
};

// Loose structural shape for Plutus data decoded by mesh. The on-chain CBOR is
// untyped at this boundary, so fields are optional and validated at runtime.
type PlutusDatum = {
	bytes?: string;
	int?: number | bigint;
	fields?: PlutusDatum[];
	constructor?: unknown;
};
type AddressObj = Parameters<typeof serializeAddressObj>[0];

function serializeOptionalAddressObj(value: unknown, networkId: 0 | 1): string | null {
	if (typeof value !== 'object' || value === null) return null;
	const datum = value as PlutusDatum;
	const ctor = datum.constructor;
	if (typeof ctor !== 'number' && typeof ctor !== 'bigint') return null;
	if (datum.fields == null) return null;

	// Plutus Option: ctor 0 = Some, ctor 1 = None. Treat None (and any empty
	// Some) as a null optional address.
	if ((ctor === 1 || ctor === 1n) && datum.fields.length === 0) {
		return null;
	}

	const addressValue = datum.fields[0];
	if (addressValue == null) {
		return null;
	}

	return serializeAddressObj(addressValue as AddressObj, networkId);
}

export function decodeV1ContractDatum(
	decodedDatum: unknown,
	network: Network,
	_smartContractAddress?: string | null,
): DecodedV1ContractDatum | null {
	const datum = decodedDatum as PlutusDatum | null;
	try {
		/*
  buyer: VerificationKeyHash,
  seller: VerificationKeyHash,
  reference_key: ByteArray,
  reference_signature: ByteArray,
  seller_nonce: ByteArray,
  buyer_nonce: ByteArray,
  collateral_return_lovelace: Int,
  input_hash: ByteArray,
  result_hash: ByteArray,
  pay_by_time: POSIXTime,
  submit_result_time: POSIXTime,
  unlock_time: POSIXTime,
  external_dispute_unlock_time: POSIXTime,
  seller_cooldown_time: POSIXTime,
  buyer_cooldown_time: POSIXTime,
  state: State,
*/
		if (datum == null) {
			//invalid transaction
			return null;
		}
		const fields = datum.fields;

		if (fields?.length != 16) {
			//invalid transaction
			return null;
		}
		const buyerAddress = serializeAddressObj(fields[0] as AddressObj, network == 'mainnet' ? 1 : 0);
		const buyerVkey = resolvePaymentKeyHash(buyerAddress);

		const sellerAddress = serializeAddressObj(fields[1] as AddressObj, network == 'mainnet' ? 1 : 0);
		const sellerVkey = resolvePaymentKeyHash(sellerAddress);

		if (fields[2] == null || fields[2].bytes == null) {
			//invalid transaction
			return null;
		}

		const referenceKey = fields[2].bytes;

		if (fields[3] == null || fields[3].bytes == null) {
			//invalid transaction
			return null;
		}
		const referenceSignature = fields[3].bytes;

		if (fields[4] == null || fields[4].bytes == null) {
			//invalid transaction
			return null;
		}
		const sellerNonce = fields[4].bytes;

		if (fields[5] == null || fields[5].bytes == null) {
			//invalid transaction
			return null;
		}
		const buyerNonce = fields[5].bytes;

		if (fields[6] == null || fields[6].int == null) {
			//invalid transaction
			return null;
		}
		const collateralReturnLovelace = BigInt(fields[6].int);
		if (fields[7] == null || fields[7].bytes == null) {
			//invalid transaction
			return null;
		}
		let inputHash: string | null = fields[7].bytes;
		if (fields[8] == null || fields[8].bytes == null) {
			//invalid transaction
			return null;
		}
		if (inputHash.length == 0) {
			inputHash = null;
		}

		let resultHash: string | null = fields[8].bytes;
		if (fields[9] == null || fields[9].int == null) {
			//invalid transaction
			return null;
		}
		if (resultHash.length == 0) {
			resultHash = null;
		}
		const payByTime = BigInt(fields[9].int);
		if (fields[10] == null || fields[10].int == null) {
			//invalid transaction
			return null;
		}
		const resultTime = BigInt(fields[10].int);
		if (fields[11] == null || fields[11].int == null) {
			//invalid transaction
			return null;
		}
		const unlockTime = BigInt(fields[11].int);
		if (fields[12] == null || fields[12].int == null) {
			//invalid transaction
			return null;
		}
		const externalDisputeUnlockTime = BigInt(fields[12].int);

		if (fields[13] == null || fields[13].int == null) {
			//invalid transaction
			return null;
		}
		const sellerCooldownTime = BigInt(fields[13].int);

		if (fields[14] == null || fields[14].int == null) {
			//invalid transaction
			return null;
		}
		const buyerCooldownTime = BigInt(fields[14].int);

		const state = valueToStatus(fields[15]);
		if (state == null) {
			//invalid transaction
			return null;
		}

		if (collateralReturnLovelace < 0n) {
			//invalid transaction
			return null;
		}

		const blockchainIdentifier = generateBlockchainIdentifier(
			referenceKey,
			referenceSignature,
			sellerNonce,
			buyerNonce,
		);

		return {
			blockchainIdentifier: blockchainIdentifier,
			buyerAddress: buyerAddress,
			sellerAddress: sellerAddress,
			buyerVkey: buyerVkey,
			sellerVkey: sellerVkey,
			state,
			referenceKey: referenceKey,
			referenceSignature: referenceSignature,
			sellerNonce: sellerNonce,
			buyerNonce: buyerNonce,
			collateralReturnLovelace,
			inputHash: inputHash,
			resultHash: resultHash,
			payByTime,
			resultTime,
			unlockTime,
			externalDisputeUnlockTime,
			buyerCooldownTime,
			sellerCooldownTime,
		};
	} catch (error) {
		logger.warn('Error decoding v1 contract datum', { error: error });
		return null;
	}
}

/**
 * The largest datum integer this service can store.
 *
 * Every numeric datum field is written to a Postgres `int8`. A Plutus integer
 * has no such bound, and nothing on chain rejects a larger one, so the check
 * has to live where the datum is read.
 */
const MAX_DATUM_INT = 2n ** 63n - 1n;

export function decodeV2ContractDatum(
	decodedDatum: unknown,
	network: Network,
	smartContractAddress?: string | null,
): DecodedV1ContractDatum | null {
	const datum = decodedDatum as PlutusDatum | null;
	try {
		if (datum == null) {
			return null;
		}
		const fields = datum.fields;

		if (fields?.length != 19) {
			return null;
		}
		const networkId = network == 'mainnet' ? 1 : 0;
		const buyerAddress = serializeAddressObj(fields[0] as AddressObj, networkId);
		const buyerReturnAddress = serializeOptionalAddressObj(fields[1], networkId);
		const buyerVkey = resolvePaymentKeyHash(buyerAddress);

		const sellerAddress = serializeAddressObj(fields[2] as AddressObj, networkId);
		const sellerReturnAddress = serializeOptionalAddressObj(fields[3], networkId);
		const sellerVkey = resolvePaymentKeyHash(sellerAddress);

		// A datum whose participant or return address equals the escrow contract
		// address bricks the on-chain payout paths: tagged payout outputs would
		// land at the script address itself, where the validator's strict
		// continuation parsing (`expect new_datum: Datum` over every
		// script-address output in vested_pay.ak) aborts the whole transaction.
		// Anyone can lock such a datum directly on-chain, so reject it here —
		// before a seller treats the lock as a valid payment and does work.
		if (
			smartContractAddress != null &&
			[buyerAddress, buyerReturnAddress, sellerAddress, sellerReturnAddress].includes(smartContractAddress)
		) {
			return null;
		}

		const referenceKey = fields[4]?.bytes;
		const referenceSignature = fields[5]?.bytes;
		const sellerNonce = fields[6]?.bytes;
		const buyerNonce = fields[7]?.bytes;
		const agentIdentifier = fields[8]?.bytes;
		const inputHashBytes = fields[10]?.bytes;
		const resultHashBytes = fields[11]?.bytes;
		if (
			typeof referenceKey !== 'string' ||
			typeof referenceSignature !== 'string' ||
			typeof sellerNonce !== 'string' ||
			typeof buyerNonce !== 'string' ||
			typeof agentIdentifier !== 'string' ||
			typeof inputHashBytes !== 'string' ||
			typeof resultHashBytes !== 'string'
		) {
			return null;
		}

		const collateralReturnLovelace = BigInt(fields[9]?.int ?? -1);
		let inputHash: string | null = inputHashBytes;
		let resultHash: string | null = resultHashBytes;
		const payByTime = BigInt(fields[12]?.int ?? -1);
		const resultTime = BigInt(fields[13]?.int ?? -1);
		const unlockTime = BigInt(fields[14]?.int ?? -1);
		const externalDisputeUnlockTime = BigInt(fields[15]?.int ?? -1);
		const sellerCooldownTime = BigInt(fields[16]?.int ?? -1);
		const buyerCooldownTime = BigInt(fields[17]?.int ?? -1);
		const state = valueToStatus(fields[18]);

		// Bounded from ABOVE as well as below. Plutus integers are arbitrary
		// precision and every one of these lands in a Postgres `int8`, so a
		// counterparty who puts 2^64 in a cooldown gets a datum the validator
		// accepts (`vested_pay.ak` compares `>=`, and so does our own
		// authorized-actor guard) and Prisma refuses. On L1 that is one failed
		// write; inside a head it is permanent — the write happens in the ordered
		// replay, the throw is caught per head and the cursor never advances, so
		// the same transaction is retried on every tick and every reconnect and no
		// escrow on that head ever moves again, with the funds inside it.
		if (
			collateralReturnLovelace < 0n ||
			payByTime < 0n ||
			resultTime < 0n ||
			unlockTime < 0n ||
			externalDisputeUnlockTime < 0n ||
			sellerCooldownTime < 0n ||
			buyerCooldownTime < 0n ||
			collateralReturnLovelace > MAX_DATUM_INT ||
			payByTime > MAX_DATUM_INT ||
			resultTime > MAX_DATUM_INT ||
			unlockTime > MAX_DATUM_INT ||
			externalDisputeUnlockTime > MAX_DATUM_INT ||
			sellerCooldownTime > MAX_DATUM_INT ||
			buyerCooldownTime > MAX_DATUM_INT ||
			state == null
		) {
			return null;
		}

		if (inputHash.length == 0) {
			inputHash = null;
		}
		if (resultHash.length == 0) {
			resultHash = null;
		}

		// V2 sellerNonce is exactly 64 hex chars (32 bytes). If the on-chain field exceeds
		// 64 chars the agentIdentifier was already concatenated upstream — keep as-is.
		// Otherwise append agentIdentifier (when present) to reconstruct the full identifier.
		const sellerIdentifier =
			sellerNonce.length > 64 || agentIdentifier.length === 0 ? sellerNonce : sellerNonce + agentIdentifier;
		const blockchainIdentifier = generateBlockchainIdentifier(
			referenceKey,
			referenceSignature,
			sellerIdentifier,
			buyerNonce,
			smartContractAddress,
		);

		return {
			blockchainIdentifier,
			buyerAddress,
			buyerReturnAddress,
			sellerAddress,
			sellerReturnAddress,
			buyerVkey,
			sellerVkey,
			state,
			referenceKey,
			referenceSignature,
			sellerNonce,
			sellerIdentifier,
			buyerNonce,
			agentIdentifier,
			collateralReturnLovelace,
			inputHash,
			resultHash,
			payByTime,
			resultTime,
			unlockTime,
			externalDisputeUnlockTime,
			buyerCooldownTime,
			sellerCooldownTime,
		};
	} catch (error) {
		logger.warn('Error decoding v2 contract datum', { error: error });
		return null;
	}
}

const DEFAULT_COOLDOWN_BLOCKTIME_BUFFER_MS = BigInt(1000 * 60 * 10);

/**
 * The smallest buffer that still satisfies the on-chain check.
 *
 * The default transaction window reaches `Date.now() + 5min + 30s` at its upper
 * bound, and the validator compares the new cooldown against that bound rather
 * than against wall-clock. A buffer under that reach makes the comparison fail
 * whenever drift is small, and it fails on chain — the transaction is built,
 * submitted and rejected. Six minutes is the first round number above it.
 *
 * Clamped rather than refused: the buffer is only a fallback for callers that
 * build the datum before their window, and taking the service down for a
 * misconfigured optional variable is the worse outcome.
 */
const MIN_COOLDOWN_BLOCKTIME_BUFFER_MS = BigInt(1000 * 60 * 6);

/** So a clamped or ignored value is reported once, not once per transaction. */
let hasWarnedAboutCooldownBuffer = false;

function warnAboutCooldownBufferOnce(message: string, meta: Record<string, string>): void {
	if (hasWarnedAboutCooldownBuffer) return;
	hasWarnedAboutCooldownBuffer = true;
	logger.warn(message, meta);
}

function resolveCooldownBlocktimeBufferMs(): bigint {
	const rawBuffer = process.env.COOLDOWN_BLOCKTIME_BUFFER_MS;
	if (rawBuffer == null || rawBuffer === '') return DEFAULT_COOLDOWN_BLOCKTIME_BUFFER_MS;
	if (!/^\d+$/.test(rawBuffer)) {
		warnAboutCooldownBufferOnce('Ignoring non-numeric COOLDOWN_BLOCKTIME_BUFFER_MS', {
			value: rawBuffer,
			using: DEFAULT_COOLDOWN_BLOCKTIME_BUFFER_MS.toString(),
		});
		return DEFAULT_COOLDOWN_BLOCKTIME_BUFFER_MS;
	}

	const bufferMs = BigInt(rawBuffer);
	if (bufferMs < MIN_COOLDOWN_BLOCKTIME_BUFFER_MS) {
		warnAboutCooldownBufferOnce(
			'COOLDOWN_BLOCKTIME_BUFFER_MS is below the minimum the on-chain cooldown check allows; using the minimum',
			{ value: rawBuffer, using: MIN_COOLDOWN_BLOCKTIME_BUFFER_MS.toString() },
		);
		return MIN_COOLDOWN_BLOCKTIME_BUFFER_MS;
	}
	return bufferMs;
}

export function newCooldownTime(cooldownTime: bigint, windowUpperMs?: number | bigint) {
	// The vested_pay validator checks the continuation datum's cooldown against
	// the tx validity UPPER bound (`cooldown_time = tx_latest_time +
	// cooldown_period`), not against wall-clock. When the caller knows its
	// window, compute from it exactly (+1s for slot-boundary rounding) — this
	// stays valid regardless of head-clock drift or window-buffer settings.
	if (windowUpperMs != null) {
		return BigInt(windowUpperMs) + cooldownTime + BigInt(1000);
	}
	// Legacy wall-clock path (V1/L1 callers that build the datum before the
	// window): the buffer must cover the window upper bound's max reach past
	// `Date.now()` (default window: +5min afterBuffer +30s slot buffer). The
	// 10-min default does; anything under MIN_COOLDOWN_BLOCKTIME_BUFFER_MS does
	// not, which is why the override is clamped rather than taken as given.
	return BigInt(Date.now()) + cooldownTime + resolveCooldownBlocktimeBufferMs();
}

function valueToStatus(value: unknown) {
	if (value == null) {
		return null;
	}
	const datum = value as PlutusDatum;
	if (datum.constructor == null || datum.fields == null || datum.fields.length != 0) {
		return null;
	}
	const constructor = datum.constructor;
	switch (constructor) {
		case 0n:
		case 0:
			return SmartContractState.FundsLocked;
		case 1n:
		case 1:
			return SmartContractState.ResultSubmitted;
		case 2n:
		case 2:
			return SmartContractState.RefundRequested;
		case 3n:
		case 3:
			return SmartContractState.Disputed;
		case 4n:
		case 4:
			return SmartContractState.WithdrawAuthorized;
		case 5n:
		case 5:
			return SmartContractState.RefundAuthorized;
	}
	return null;
}
