import {
	getDatumFromBlockchainIdentifier,
	getPaymentScriptFromPaymentSourceV1,
	getRegistryScriptFromNetworkHandlerV1,
	paymentSourceV1Adapter,
} from '@masumi/payment-source-v1';
import {
	getDatumV2,
	getPaymentScriptFromPaymentSourceV2,
	getRegistryScriptFromNetworkHandlerV2,
	paymentSourceV2Adapter,
} from '@masumi/payment-source-v2';
import { Network, PaymentSource, PaymentSourceType } from '@/generated/prisma/client';
import type { Data, PlutusScript } from '@meshsdk/core';
import {
	DecodedV1ContractDatum,
	decodeV1ContractDatum,
	decodeV2ContractDatum,
} from '@/utils/converter/string-datum-convert';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { assertNever } from '@/utils/assert-never';

export type PaymentSourceWithContractWallets = PaymentSource & {
	AdminWallets: Array<{ walletAddress: string; order: number }>;
	FeeReceiverNetworkWallet: { walletAddress: string; order: number } | null;
};

export type ContractDatum = {
	value: Data;
	inline: boolean;
};

export type ContractDatumInput = {
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

export type ContractDatumFromDecodedInput = {
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

export type PaymentSourceContractAdapter = {
	paymentSourceType: PaymentSourceType;
	label: string;
	getPaymentScriptFromPaymentSource(
		paymentSource: PaymentSourceWithContractWallets,
	): Promise<{ script: PlutusScript; smartContractAddress: string }>;
	getRegistryScriptFromPaymentSource(
		paymentSource: PaymentSource,
	): Promise<{ script: PlutusScript; policyId: string; smartContractAddress: string }>;
	decodeContractDatum(
		decodedDatum: unknown,
		network: 'mainnet' | 'preprod' | 'preview' | 'testnet',
		smartContractAddress?: string | null,
	): DecodedV1ContractDatum | null;
	createDatumFromBlockchainIdentifier(input: ContractDatumInput): ContractDatum;
	createDatumFromDecodedContract(input: ContractDatumFromDecodedInput): ContractDatum;
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

const v1ContractAdapter = {
	...paymentSourceV1Adapter,
	getPaymentScriptFromPaymentSource: getPaymentScriptFromPaymentSourceV1,
	getRegistryScriptFromPaymentSource: getRegistryScriptFromNetworkHandlerV1,
	decodeContractDatum: decodeV1ContractDatum,
	createDatumFromBlockchainIdentifier: getDatumFromBlockchainIdentifier,
	createDatumFromDecodedContract(input: ContractDatumFromDecodedInput) {
		// V1 contract has no buyer/seller-return-address concept (the v2
		// vested_pay validator added them). Silently dropping caller-passed
		// values would let bugs upstream go undetected: a caller that
		// branches "v1 vs v2" incorrectly would think the routing field
		// was honored. Fail loudly so the wrong-branch bug surfaces at
		// the boundary instead of as a wrong-routing on-chain payout.
		if (input.buyerReturnAddress != null) {
			throw new Error(
				'v1ContractAdapter.createDatumFromDecodedContract: V1 contracts do not support buyerReturnAddress; caller is mis-routing a V2 input through the V1 adapter',
			);
		}
		if (input.sellerReturnAddress != null) {
			throw new Error(
				'v1ContractAdapter.createDatumFromDecodedContract: V1 contracts do not support sellerReturnAddress; caller is mis-routing a V2 input through the V1 adapter',
			);
		}
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
	},
};

const v2ContractAdapter = {
	...paymentSourceV2Adapter,
	getPaymentScriptFromPaymentSource: getPaymentScriptFromPaymentSourceV2,
	getRegistryScriptFromPaymentSource: getRegistryScriptFromNetworkHandlerV2,
	decodeContractDatum: decodeV2ContractDatum,
	createDatumFromBlockchainIdentifier(input: ContractDatumInput) {
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
	},
	createDatumFromDecodedContract(input: ContractDatumFromDecodedInput) {
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
	},
};

export function getPaymentSourceContractAdapter(paymentSourceType: PaymentSourceType): PaymentSourceContractAdapter {
	switch (paymentSourceType) {
		case PaymentSourceType.Web3CardanoV1:
			return v1ContractAdapter;
		case PaymentSourceType.Web3CardanoV2:
			return v2ContractAdapter;
		default:
			return assertNever(paymentSourceType);
	}
}

export function getDatumNetwork(network: Network): 'mainnet' | 'preprod' {
	return network === Network.Mainnet ? 'mainnet' : 'preprod';
}
