import { deserializeDatum, UTxO } from '@meshsdk/core';
import { OnChainState } from '@/generated/prisma/client';
import { decodeV2ContractDatum, DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';

/**
 * Shared "does this on-chain UTxO belong to this request?" matching for the V2
 * batch services. The decoded datum must agree with the request on state, both
 * parties, identifiers and every time/lovelace field before a UTxO is treated
 * as the request's contract UTxO.
 *
 * V2-mesh-pinned: `deserializeDatum` resolves to this package's mesh line
 * (ADR 0005) — do NOT hoist this module out of payment-source-v2.
 */
interface WalletKeys {
	walletVkey: string;
	walletAddress: string;
}

export interface MatchableRequestFields {
	onChainState: OnChainState | null;
	blockchainIdentifier: string;
	inputHash: string;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	collateralReturnLovelace: bigint | null;
	payByTime: bigint | null;
}

export interface MatchingUtxoResult {
	utxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
}

interface Parties {
	buyerVkey: string | undefined;
	buyerAddress: string | undefined;
	sellerVkey: string | undefined;
	sellerAddress: string | undefined;
}

function findMatchingUtxoWithContract(
	utxoList: UTxO[],
	txHash: string,
	request: MatchableRequestFields,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
	parties: () => Parties,
): MatchingUtxoResult | undefined {
	for (const utxo of utxoList) {
		if (utxo.input.txHash !== txHash) continue;
		const utxoDatum = utxo.output.plutusData;
		if (!utxoDatum) continue;
		const decodedDatum: unknown = deserializeDatum(utxoDatum);
		const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
		if (decodedContract == null) continue;
		const expected = parties();
		if (
			smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState) &&
			decodedContract.buyerVkey === expected.buyerVkey &&
			decodedContract.sellerVkey === expected.sellerVkey &&
			decodedContract.buyerAddress === expected.buyerAddress &&
			decodedContract.sellerAddress === expected.sellerAddress &&
			decodedContract.blockchainIdentifier === request.blockchainIdentifier &&
			decodedContract.inputHash === request.inputHash &&
			BigInt(decodedContract.resultTime) === BigInt(request.submitResultTime) &&
			BigInt(decodedContract.unlockTime) === BigInt(request.unlockTime) &&
			BigInt(decodedContract.externalDisputeUnlockTime) === BigInt(request.externalDisputeUnlockTime) &&
			BigInt(decodedContract.collateralReturnLovelace) === BigInt(request.collateralReturnLovelace ?? 0) &&
			BigInt(decodedContract.payByTime) === BigInt(request.payByTime ?? 0)
		) {
			return { utxo, decodedContract };
		}
	}
	return undefined;
}

/** Payment (seller) side: the buyer is the counterparty wallet, the seller is our hot wallet. */
export function findMatchingPaymentUtxoWithContract(
	utxoList: UTxO[],
	txHash: string,
	request: MatchableRequestFields & {
		BuyerWallet: WalletKeys | null;
		SmartContractWallet: WalletKeys | null;
	},
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): MatchingUtxoResult | undefined {
	return findMatchingUtxoWithContract(utxoList, txHash, request, network, smartContractAddress, () => ({
		buyerVkey: request.BuyerWallet?.walletVkey,
		buyerAddress: request.BuyerWallet?.walletAddress,
		sellerVkey: request.SmartContractWallet?.walletVkey,
		sellerAddress: request.SmartContractWallet?.walletAddress,
	}));
}

export function findMatchingPaymentUtxo(
	utxoList: UTxO[],
	txHash: string,
	request: MatchableRequestFields & {
		BuyerWallet: WalletKeys | null;
		SmartContractWallet: WalletKeys | null;
	},
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): UTxO | undefined {
	return findMatchingPaymentUtxoWithContract(utxoList, txHash, request, network, smartContractAddress)?.utxo;
}

/** Purchase (buyer) side: our hot wallet is the buyer, the seller is the counterparty wallet. */
export function findMatchingPurchaseUtxo(
	utxoList: UTxO[],
	txHash: string,
	request: MatchableRequestFields & {
		SellerWallet: WalletKeys;
		SmartContractWallet: WalletKeys | null;
	},
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): UTxO | undefined {
	return findMatchingUtxoWithContract(utxoList, txHash, request, network, smartContractAddress, () => ({
		buyerVkey: request.SmartContractWallet?.walletVkey,
		buyerAddress: request.SmartContractWallet?.walletAddress,
		sellerVkey: request.SellerWallet.walletVkey,
		sellerAddress: request.SellerWallet.walletAddress,
	}))?.utxo;
}
