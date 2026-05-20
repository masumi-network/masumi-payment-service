/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { generateBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@/utils/logger';
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

function serializeOptionalAddressObj(value: any, networkId: 0 | 1): string | null {
	if (value == null || value.constructor == null || value.fields == null) {
		return null;
	}

	const constructor = value.constructor;
	if ((constructor === 1 || constructor === 1n) && value.fields.length === 0) {
		return null;
	}

	const addressValue = value.fields[0];
	if (addressValue == null) {
		return null;
	}

	return serializeAddressObj(addressValue, networkId);
}

export function decodeV1ContractDatum(decodedDatum: any, network: Network): DecodedV1ContractDatum | null {
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
		if (decodedDatum == null) {
			//invalid transaction
			return null;
		}
		const fields = decodedDatum.fields;

		if (fields?.length != 16) {
			//invalid transaction
			return null;
		}
		const buyerAddress = serializeAddressObj(fields[0], network == 'mainnet' ? 1 : 0);
		const buyerVkey = resolvePaymentKeyHash(buyerAddress);

		const sellerAddress = serializeAddressObj(fields[1], network == 'mainnet' ? 1 : 0);
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
		let inputHash: string | null = fields[7].bytes as string;
		if (fields[8] == null || fields[8].bytes == null) {
			//invalid transaction
			return null;
		}
		if (inputHash.length == 0) {
			inputHash = null;
		}

		let resultHash: string | null = fields[8].bytes as string;
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
			referenceKey as string,
			referenceSignature as string,
			sellerNonce as string,
			buyerNonce as string,
		);

		return {
			blockchainIdentifier: blockchainIdentifier,
			buyerAddress: buyerAddress,
			sellerAddress: sellerAddress,
			buyerVkey: buyerVkey,
			sellerVkey: sellerVkey,
			state,
			referenceKey: referenceKey as string,
			referenceSignature: referenceSignature as string,
			sellerNonce: sellerNonce as string,
			buyerNonce: buyerNonce as string,
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

export function decodeV2ContractDatum(decodedDatum: any, network: Network): DecodedV1ContractDatum | null {
	try {
		if (decodedDatum == null) {
			return null;
		}
		const fields = decodedDatum.fields;

		if (fields?.length != 19) {
			return null;
		}
		const networkId = network == 'mainnet' ? 1 : 0;
		const buyerAddress = serializeAddressObj(fields[0], networkId);
		const buyerReturnAddress = serializeOptionalAddressObj(fields[1], networkId);
		const buyerVkey = resolvePaymentKeyHash(buyerAddress);

		const sellerAddress = serializeAddressObj(fields[2], networkId);
		const sellerReturnAddress = serializeOptionalAddressObj(fields[3], networkId);
		const sellerVkey = resolvePaymentKeyHash(sellerAddress);

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

		if (
			collateralReturnLovelace < 0n ||
			payByTime < 0n ||
			resultTime < 0n ||
			unlockTime < 0n ||
			externalDisputeUnlockTime < 0n ||
			sellerCooldownTime < 0n ||
			buyerCooldownTime < 0n ||
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

export function newCooldownTime(cooldownTime: bigint) {
	//We add some additional cooldown time to avoid validity issues with blocktime
	const cooldownTimeMs = BigInt(Date.now()) + cooldownTime + BigInt(1000 * 60 * 10);
	return cooldownTimeMs;
}

function valueToStatus(value: any) {
	if (value == null) {
		return null;
	}
	if (value.constructor == null || value.fields == null || value.fields.length != 0) {
		return null;
	}
	const constructor = value.constructor;
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
