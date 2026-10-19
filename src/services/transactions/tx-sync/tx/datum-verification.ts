import { logger } from '@masumi/payment-core/logger';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';

export function nullableStringEquals(left: string | null | undefined, right: string | null | undefined) {
	return (left ?? null) === (right ?? null);
}

/**
 * Structural minimum needed to verify a PaymentRequest / PurchaseRequest row
 * against an on-chain datum after a lookup by `blockchainIdentifier` only.
 * Each `kind` ('payment' | 'purchase') swaps which relation holds the buyer
 * vs the seller wallet; see contract docs above the call sites.
 */
type RequestRowWithWallets = {
	payByTime: bigint | null;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	BuyerWallet?: { walletVkey: string; walletAddress: string } | null;
	SellerWallet?: { walletVkey: string; walletAddress: string } | null;
	SmartContractWallet?: { walletVkey: string; walletAddress: string } | null;
};

/**
 * Null-tolerant verification of DB fields against the on-chain datum. Returns
 * `true` when the row is consistent with the datum (or when the DB value is
 * null, which signals a legacy row pre-dating the column — accepted).
 *
 * Spoofing defence preserved: when a DB field is non-null AND diverges from
 * the on-chain value, log a warning and return `false` so the caller skips
 * the update. The legacy null case only applies to `payByTime` (added by
 * migration 20250622215253_add_pay_by_time without a backfill). All other
 * time fields are non-nullable in the schema and must match exactly.
 */
export function verifyRequestFieldsAgainstDatum(
	request: RequestRowWithWallets,
	datum: DecodedV1ContractDatum,
	kind: 'payment' | 'purchase',
	txHash: string,
): boolean {
	if (request.payByTime != null && request.payByTime !== datum.payByTime) {
		logger.warn(`${kind} request payByTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbPayByTime: request.payByTime,
			chainPayByTime: datum.payByTime,
		});
		return false;
	}
	if (request.submitResultTime !== datum.resultTime) {
		logger.warn(`${kind} request submitResultTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbSubmitResultTime: request.submitResultTime,
			chainResultTime: datum.resultTime,
		});
		return false;
	}
	if (request.unlockTime !== datum.unlockTime) {
		logger.warn(`${kind} request unlockTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbUnlockTime: request.unlockTime,
			chainUnlockTime: datum.unlockTime,
		});
		return false;
	}
	if (request.externalDisputeUnlockTime !== datum.externalDisputeUnlockTime) {
		logger.warn(`${kind} request externalDisputeUnlockTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbExternalDisputeUnlockTime: request.externalDisputeUnlockTime,
			chainExternalDisputeUnlockTime: datum.externalDisputeUnlockTime,
		});
		return false;
	}
	// Payment-side: BuyerWallet holds buyer keys, SmartContractWallet holds the
	// seller's hot wallet keys. Purchase-side is symmetric — SellerWallet holds
	// the seller keys, SmartContractWallet holds the buyer's hot wallet keys.
	if (kind === 'payment') {
		if (
			request.BuyerWallet != null &&
			(request.BuyerWallet.walletVkey !== datum.buyerVkey || request.BuyerWallet.walletAddress !== datum.buyerAddress)
		) {
			logger.warn('payment request BuyerWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbBuyerVkey: request.BuyerWallet.walletVkey,
				dbBuyerAddress: request.BuyerWallet.walletAddress,
				chainBuyerVkey: datum.buyerVkey,
				chainBuyerAddress: datum.buyerAddress,
			});
			return false;
		}
		if (
			request.SmartContractWallet != null &&
			(request.SmartContractWallet.walletVkey !== datum.sellerVkey ||
				request.SmartContractWallet.walletAddress !== datum.sellerAddress)
		) {
			logger.warn('payment request SmartContractWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbSellerVkey: request.SmartContractWallet.walletVkey,
				dbSellerAddress: request.SmartContractWallet.walletAddress,
				chainSellerVkey: datum.sellerVkey,
				chainSellerAddress: datum.sellerAddress,
			});
			return false;
		}
	} else {
		if (
			request.SellerWallet != null &&
			(request.SellerWallet.walletVkey !== datum.sellerVkey ||
				request.SellerWallet.walletAddress !== datum.sellerAddress)
		) {
			logger.warn('purchase request SellerWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbSellerVkey: request.SellerWallet.walletVkey,
				dbSellerAddress: request.SellerWallet.walletAddress,
				chainSellerVkey: datum.sellerVkey,
				chainSellerAddress: datum.sellerAddress,
			});
			return false;
		}
		if (
			request.SmartContractWallet != null &&
			(request.SmartContractWallet.walletVkey !== datum.buyerVkey ||
				request.SmartContractWallet.walletAddress !== datum.buyerAddress)
		) {
			logger.warn('purchase request SmartContractWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbBuyerVkey: request.SmartContractWallet.walletVkey,
				dbBuyerAddress: request.SmartContractWallet.walletAddress,
				chainBuyerVkey: datum.buyerVkey,
				chainBuyerAddress: datum.buyerAddress,
			});
			return false;
		}
	}
	return true;
}

export function v2ReturnAddressesMatch(left: DecodedV1ContractDatum, right: DecodedV1ContractDatum) {
	return (
		nullableStringEquals(left.buyerReturnAddress, right.buyerReturnAddress) &&
		nullableStringEquals(left.sellerReturnAddress, right.sellerReturnAddress)
	);
}
