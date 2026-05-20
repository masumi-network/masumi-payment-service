import { getDatumFromBlockchainIdentifier } from './contract-generator';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { SmartContractState } from '@/utils/generator/contract-generator';

export type V1DatumFromDecodedInput = {
	decodedContract: DecodedV1ContractDatum;
	buyerAddress?: string;
	sellerAddress?: string;
	blockchainIdentifier: string;
	resultHash: string | null;
	newCooldownTimeSeller: bigint;
	newCooldownTimeBuyer: bigint;
	state: SmartContractState;
};

export function createDatumFromDecodedContractV1(input: V1DatumFromDecodedInput) {
	return getDatumFromBlockchainIdentifier({
		buyerAddress: input.buyerAddress ?? input.decodedContract.buyerAddress,
		sellerAddress: input.sellerAddress ?? input.decodedContract.sellerAddress,
		blockchainIdentifier: input.blockchainIdentifier,
		inputHash: input.decodedContract.inputHash,
		resultHash: input.resultHash,
		payByTime: input.decodedContract.payByTime,
		collateralReturnLovelace: input.decodedContract.collateralReturnLovelace,
		resultTime: input.decodedContract.resultTime,
		unlockTime: input.decodedContract.unlockTime,
		externalDisputeUnlockTime: input.decodedContract.externalDisputeUnlockTime,
		newCooldownTimeSeller: input.newCooldownTimeSeller,
		newCooldownTimeBuyer: input.newCooldownTimeBuyer,
		state: input.state,
	});
}
