import { deserializeDatum, UTxO } from '@meshsdk/core';
import { OnChainState } from '@/generated/prisma/client';
import { decodeV2ContractDatum, DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';

/**
 * Shared "does this on-chain UTxO belong to this request?" matching for the V2
 * batch services. The output must be at the configured contract address and,
 * when Hydra lineage is persisted, have the exact tracked output reference.
 * Its decoded datum must also agree with the request on state, both parties,
 * identifiers and every time/lovelace field before it is treated as escrow.
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
	currentHydraUtxoTxHash?: string | null;
	currentHydraUtxoOutputIndex?: number | null;
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
	const hasHydraTxHash = request.currentHydraUtxoTxHash != null;
	const hasHydraOutputIndex = request.currentHydraUtxoOutputIndex != null;
	if (hasHydraTxHash !== hasHydraOutputIndex) {
		// A partial durable output reference is corrupt/ambiguous. Never fall back to
		// datum-only selection because that could spend a counterparty-controlled
		// decoy output from the same transaction.
		return undefined;
	}
	if (hasHydraTxHash && request.currentHydraUtxoTxHash !== txHash) {
		return undefined;
	}

	const matches: MatchingUtxoResult[] = [];
	for (const utxo of utxoList) {
		if (utxo.input.txHash !== txHash) continue;
		if (utxo.output.address !== smartContractAddress) continue;
		if (hasHydraOutputIndex && utxo.input.outputIndex !== request.currentHydraUtxoOutputIndex) continue;
		const utxoDatum = utxo.output.plutusData;
		if (!utxoDatum) continue;
		try {
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
				matches.push({ utxo, decodedContract });
			}
		} catch {
			// Every datum in the shared snapshot is counterparty-controlled. A
			// malformed sibling must not prevent selection of the independently
			// validated exact/unique escrow output.
			continue;
		}
	}
	// With a durable Hydra reference this can contain at most one real UTxO. The
	// compatibility path for legacy/L1 rows is also fail-closed: identical datum
	// copies in one transaction are ambiguous, so never pick whichever came first.
	return matches.length === 1 ? matches[0] : undefined;
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
