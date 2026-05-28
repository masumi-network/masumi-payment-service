import { getDatumV2 } from './contract-generator';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { SmartContractState } from '@/utils/generator/contract-generator';

export type V2DatumInput = {
	buyerAddress: string;
	buyerReturnAddress?: string | null;
	sellerAddress: string;
	sellerReturnAddress?: string | null;
	blockchainIdentifier: string;
	collateralReturnLovelace: bigint;
	inputHash: string | null;
	resultHash: string | null;
	payByTime: bigint;
	resultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	newCooldownTimeSeller: bigint;
	newCooldownTimeBuyer: bigint;
	state: SmartContractState;
};

export type V2DatumFromDecodedInput = {
	decodedContract: DecodedV1ContractDatum;
	buyerAddress?: string;
	buyerReturnAddress?: string | null;
	sellerAddress?: string;
	sellerReturnAddress?: string | null;
	blockchainIdentifier: string;
	resultHash: string | null;
	newCooldownTimeSeller: bigint;
	newCooldownTimeBuyer: bigint;
	state: SmartContractState;
};

function getV2IdentifierParts(blockchainIdentifier: string) {
	const decoded = decodeBlockchainIdentifier(blockchainIdentifier);
	if (decoded == null) {
		throw new Error('Invalid blockchain identifier');
	}
	return {
		referenceKey: decoded.key,
		referenceSignature: decoded.signature,
		sellerNonce: decoded.agentIdentifier == null ? decoded.sellerId : decoded.sellerId.slice(0, 64),
		buyerNonce: decoded.purchaserId,
		agentIdentifier: decoded.agentIdentifier,
	};
}

export function createDatumFromBlockchainIdentifierV2(input: V2DatumInput) {
	const identifierParts = getV2IdentifierParts(input.blockchainIdentifier);
	return getDatumV2({
		buyerAddress: input.buyerAddress,
		buyerReturnAddress: input.buyerReturnAddress,
		sellerAddress: input.sellerAddress,
		sellerReturnAddress: input.sellerReturnAddress,
		...identifierParts,
		collateralReturnLovelace: input.collateralReturnLovelace,
		inputHash: input.inputHash,
		resultHash: input.resultHash,
		payByTime: input.payByTime,
		resultTime: input.resultTime,
		unlockTime: input.unlockTime,
		externalDisputeUnlockTime: input.externalDisputeUnlockTime,
		newCooldownTimeSeller: input.newCooldownTimeSeller,
		newCooldownTimeBuyer: input.newCooldownTimeBuyer,
		state: input.state,
	});
}

export function createDatumFromDecodedContractV2(input: V2DatumFromDecodedInput) {
	return getDatumV2({
		buyerAddress: input.buyerAddress ?? input.decodedContract.buyerAddress,
		buyerReturnAddress: input.buyerReturnAddress ?? input.decodedContract.buyerReturnAddress,
		sellerAddress: input.sellerAddress ?? input.decodedContract.sellerAddress,
		sellerReturnAddress: input.sellerReturnAddress ?? input.decodedContract.sellerReturnAddress,
		referenceKey: input.decodedContract.referenceKey,
		referenceSignature: input.decodedContract.referenceSignature,
		sellerNonce: input.decodedContract.sellerNonce,
		buyerNonce: input.decodedContract.buyerNonce,
		agentIdentifier: input.decodedContract.agentIdentifier,
		collateralReturnLovelace: input.decodedContract.collateralReturnLovelace,
		inputHash: input.decodedContract.inputHash,
		resultHash: input.resultHash,
		payByTime: input.decodedContract.payByTime,
		resultTime: input.decodedContract.resultTime,
		unlockTime: input.decodedContract.unlockTime,
		externalDisputeUnlockTime: input.decodedContract.externalDisputeUnlockTime,
		newCooldownTimeSeller: input.newCooldownTimeSeller,
		newCooldownTimeBuyer: input.newCooldownTimeBuyer,
		state: input.state,
	});
}
