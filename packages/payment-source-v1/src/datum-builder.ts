import { getDatumFromBlockchainIdentifier } from './contract-generator';
// TODO(v1-package-boundary): move DecodedV1ContractDatum / decodeV1ContractDatum to @masumi/payment-core
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
// Import SmartContractState directly from payment-core to break the
// V1 → src/utils/generator/contract-generator → @masumi/payment-source-v1 cycle.
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';

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
