import { HotWalletType, PaymentSourceType, PricingType } from '@/generated/prisma/client';
import { getPublicKeyFromCoseKey } from '@/utils/converter/public-key-convert';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { metadataSchema, resolveAgentPricingFromMetadata } from '../registry/wallet';
import { normalizePurchaseUnit } from '@/utils/shared/transformers';
import { validateHexString } from '@/utils/validator/hex';
import { checkSignature, resolvePaymentKeyHash } from '@meshsdk/core';
import createHttpError from 'http-errors';
import stringify from 'canonical-json';
import { prisma } from '@masumi/payment-core/db';
import { buildSignedBlockchainIdentifierPayload } from '@/utils/generator/blockchain-identifier-payload';

interface PurchaseInitBaseInput {
	network: 'Preprod' | 'Mainnet';
	blockchainIdentifier: string;
	inputHash: string;
	sellerVkey: string;
	agentIdentifier: string;
	Amounts?: Array<{ amount: string; unit: string }>;
	unlockTime: string;
	externalDisputeUnlockTime: string;
	submitResultTime: string;
	payByTime: string;
	identifierFromPurchaser: string;
	paymentSourceType: PaymentSourceType;
	sellerReturnAddress?: string;
}

export async function resolvePurchaseCreationContext({
	input,
	paymentSourceId,
	rpcProviderApiKey,
	smartContractAddress,
}: {
	input: PurchaseInitBaseInput;
	paymentSourceId: string;
	rpcProviderApiKey: string;
	smartContractAddress: string;
}) {
	const policyId = input.agentIdentifier.substring(0, 56);
	const additionalExternalDisputeUnlockTime = BigInt(1000 * 60 * 15);
	const submitResultTime = BigInt(input.submitResultTime);
	const payByTime = BigInt(input.payByTime);
	const unlockTime = BigInt(input.unlockTime);
	const externalDisputeUnlockTime = BigInt(input.externalDisputeUnlockTime);

	if (payByTime > submitResultTime - BigInt(1000 * 60 * 5)) {
		throw createHttpError(400, 'Pay by time must be before submit result time (min. 5 minutes)');
	}
	if (payByTime < BigInt(Date.now() - 1000 * 60 * 5)) {
		throw createHttpError(400, 'Pay by time must be in the future (max. 5 minutes)');
	}
	if (externalDisputeUnlockTime < unlockTime + additionalExternalDisputeUnlockTime) {
		throw createHttpError(400, 'External dispute unlock time must be after unlock time (min. 15 minutes difference)');
	}
	if (submitResultTime < BigInt(Date.now() + 1000 * 60 * 15)) {
		throw createHttpError(400, 'Submit result time must be in the future (min. 15 minutes)');
	}
	const offset = BigInt(1000 * 60 * 15);
	if (submitResultTime > unlockTime - offset) {
		throw createHttpError(400, 'Submit result time must be before unlock time with at least 15 minutes difference');
	}

	const provider = getBlockfrostInstance(input.network, rpcProviderApiKey);
	const policyAsset = input.agentIdentifier.startsWith(policyId)
		? input.agentIdentifier
		: policyId + input.agentIdentifier;
	const assetInWallet = await provider.assetsAddresses(policyAsset, { order: 'desc', count: 1 });

	if (assetInWallet.length === 0) {
		throw createHttpError(404, 'Agent identifier not found');
	}
	const sellerAddress = assetInWallet[0].address;
	if (sellerAddress == null) {
		throw createHttpError(404, 'Agent identifier not found');
	}

	const sellerAddressVkey = resolvePaymentKeyHash(sellerAddress);
	if (sellerAddressVkey !== input.sellerVkey) {
		throw createHttpError(400, 'Invalid seller vkey');
	}
	const sellerCollectionAddress =
		(
			await prisma.hotWallet.findFirst({
				where: {
					paymentSourceId,
					type: HotWalletType.Selling,
					deletedAt: null,
					walletVkey: input.sellerVkey,
					walletAddress: sellerAddress,
				},
				select: {
					collectionAddress: true,
				},
			})
		)?.collectionAddress ?? null;
	// Buyer-supplied `sellerReturnAddress` overrides the seller's stored
	// collection address for BOTH V1 and V2. Previously V1 silently dropped
	// the input field and always used `sellerCollectionAddress`, which made
	// `input.sellerReturnAddress` look like a no-op for V1 callers with no
	// validation error to signal the silent drop. V1's contract / collection
	// service already honors `request.sellerReturnAddress` when present
	// (see packages/payment-source-v1/src/services/payments/collection/service.ts),
	// so propagating it here is the consistent behavior.
	const sellerReturnAddress = input.sellerReturnAddress ?? sellerCollectionAddress;

	const assetInfo = await provider.assetsById(input.agentIdentifier);
	if (!assetInfo.onchain_metadata) {
		throw createHttpError(404, 'Agent identifier not found');
	}

	const parsedMetadata = metadataSchema.safeParse(assetInfo.onchain_metadata);
	if (!parsedMetadata.success || !parsedMetadata.data) {
		throw createHttpError(404, 'Agent identifier metadata invalid or unsupported');
	}

	const pricing = resolveAgentPricingFromMetadata(parsedMetadata.data);
	if (pricing == null) {
		throw createHttpError(400, 'Agent metadata does not advertise any pricing');
	}
	if (pricing.pricingType !== PricingType.Fixed && pricing.pricingType !== PricingType.Dynamic) {
		throw createHttpError(400, 'Agent identifier pricing type not supported');
	}

	const requestedCostMap = new Map<string, bigint>();
	if (pricing.pricingType === PricingType.Fixed) {
		for (const amount of pricing.fixedPricing) {
			const unit = normalizePurchaseUnit(metadataToString(amount.unit)!);
			requestedCostMap.set(unit, (requestedCostMap.get(unit) ?? 0n) + BigInt(amount.amount));
		}
		if (input.Amounts != null) {
			const inputAmountsMap = new Map<string, bigint>();
			for (const amount of input.Amounts) {
				const unit = normalizePurchaseUnit(amount.unit);
				inputAmountsMap.set(unit, (inputAmountsMap.get(unit) ?? 0n) + BigInt(amount.amount));
			}
			if (inputAmountsMap.size !== requestedCostMap.size) {
				throw createHttpError(400, 'Provided Amounts do not match the fixed pricing of the agent');
			}
			for (const [unit, amount] of requestedCostMap) {
				if (inputAmountsMap.get(unit) !== amount) {
					throw createHttpError(400, 'Provided Amounts do not match the fixed pricing of the agent');
				}
			}
		}
	} else {
		if (input.Amounts == null || input.Amounts.length === 0) {
			throw createHttpError(400, 'For dynamic pricing, Amounts must be provided');
		}
		for (const fund of input.Amounts) {
			if (BigInt(fund.amount) <= 0n) {
				throw createHttpError(400, 'Amounts must be positive');
			}
		}
		for (const amount of input.Amounts) {
			const unit = normalizePurchaseUnit(amount.unit);
			requestedCostMap.set(unit, (requestedCostMap.get(unit) ?? 0n) + BigInt(amount.amount));
		}
	}

	const decoded = decodeBlockchainIdentifier(input.blockchainIdentifier);
	if (decoded == null) {
		throw createHttpError(400, 'Invalid blockchain identifier, format invalid');
	}

	const purchaserId = decoded.purchaserId;
	const sellerId = decoded.sellerId;
	if (purchaserId !== input.identifierFromPurchaser) {
		throw createHttpError(400, 'Invalid blockchain identifier, purchaser id mismatch');
	}
	if (!validateHexString(purchaserId)) {
		throw createHttpError(400, 'Purchaser identifier is not a valid hex string');
	}
	if (!validateHexString(sellerId)) {
		throw createHttpError(400, 'Seller identifier is not a valid hex string');
	}
	if (decoded.agentIdentifier !== input.agentIdentifier) {
		throw createHttpError(400, 'Invalid blockchain identifier, agent identifier mismatch');
	}

	const cosePublicKey = getPublicKeyFromCoseKey(decoded.key);
	if (cosePublicKey == null) {
		throw createHttpError(400, 'Invalid blockchain identifier, key not found');
	}
	if (cosePublicKey.hash().hex() !== input.sellerVkey) {
		throw createHttpError(400, 'Invalid blockchain identifier, key does not match');
	}

	const resolvedPaymentSourceType = input.paymentSourceType;
	const isV2 = resolvedPaymentSourceType === PaymentSourceType.Web3CardanoV2;
	if (isV2 && decoded.smartContractAddress == null) {
		throw createHttpError(400, 'Invalid blockchain identifier, V2 must carry smartContractAddress');
	}
	// Defense-in-depth: fast-fail when the identifier's smartContractAddress doesn't match
	// the resolved paymentSource. The signature check below would also reject this case (the
	// reconstructed payload uses `decoded.smartContractAddress`, so tampering breaks the hash),
	// but rejecting before crypto saves a SHA-256 round-trip and gives a clearer error.
	if (isV2 && decoded.smartContractAddress !== smartContractAddress) {
		throw createHttpError(400, 'Invalid blockchain identifier, smartContractAddress mismatch');
	}
	// Reconstruct using the address carried in the identifier itself (not the looked-up paymentSource
	// address), so the signature check directly verifies what the buyer submitted — tampering
	// segment [4] makes the signature verification below fail by construction.
	const reconstructedBlockchainIdentifier = buildSignedBlockchainIdentifierPayload({
		inputHash: input.inputHash,
		agentIdentifier: input.agentIdentifier,
		purchaserIdentifier: purchaserId,
		sellerIdentifier: sellerId,
		requestedFunds:
			pricing.pricingType === PricingType.Dynamic && input.Amounts != null
				? input.Amounts.map((amount) => ({
						amount: amount.amount,
						unit: normalizePurchaseUnit(amount.unit),
					}))
				: null,
		payByTime: input.payByTime,
		submitResultTime: input.submitResultTime,
		unlockTime: unlockTime.toString(),
		externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
		sellerAddress,
		sellerReturnAddress,
		smartContractAddress: isV2 ? decoded.smartContractAddress : null,
		paymentSourceType: resolvedPaymentSourceType,
	});

	const hashedBlockchainIdentifier = generateSHA256Hash(stringify(reconstructedBlockchainIdentifier));
	const identifierIsSignedCorrectly = await checkSignature(hashedBlockchainIdentifier, {
		signature: decoded.signature,
		key: decoded.key,
	});
	if (!identifierIsSignedCorrectly) {
		throw createHttpError(400, 'Invalid blockchain identifier, signature invalid');
	}

	return {
		payByTime,
		submitResultTime,
		unlockTime,
		externalDisputeUnlockTime,
		sellerAddress,
		sellerReturnAddress,
		pricingType: pricing.pricingType,
		onChainAgentName: metadataToString(parsedMetadata.data.name),
		requestedCost: Array.from(requestedCostMap.entries()).map(([unit, amount]) => ({
			amount,
			unit,
		})),
	};
}
