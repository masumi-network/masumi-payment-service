import { z } from '@/utils/zod-openapi';
import { HotWalletType, PricingType, PurchasingAction } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { checkSignature, resolvePaymentKeyHash, BlockfrostProvider } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { metadataSchema } from '../../registry/wallet';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { handlePurchaseCreditInit } from '@/services/integrations';
import stringify from 'canonical-json';
import { getPublicKeyFromCoseKey } from '@/utils/converter/public-key-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import { validateHexString } from '@/utils/validator/hex';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { HttpExistsError } from '@/utils/errors/http-exists-error';
import { recordBusinessEndpointError } from '@/utils/metrics';
import {
	normalizePurchaseUnit,
	transformPurchaseGetAmounts,
	transformPurchaseGetTimestamps,
} from '@/utils/shared/transformers';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { connectPreviousAction, createNextPurchaseAction } from '@/services/shared';
import { buildX402FundsLockingTransaction } from '@/services/purchases/x402-build/service';
import { createX402PurchaseSchemaInput, createX402PurchaseSchemaOutput } from './schemas';
import { CONSTANTS } from '@/utils/config';

export { createX402PurchaseSchemaInput, createX402PurchaseSchemaOutput };

const purchaseRequestResponseInclude = {
	SellerWallet: { select: { id: true, walletVkey: true } },
	SmartContractWallet: {
		where: { deletedAt: null },
		select: { id: true, walletVkey: true, walletAddress: true },
	},
	PaymentSource: {
		select: {
			id: true,
			network: true,
			smartContractAddress: true,
			policyId: true,
		},
	},
	WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
	WithdrawnForSeller: { select: { id: true, amount: true, unit: true } },
	PaidFunds: { select: { id: true, amount: true, unit: true } },
	NextAction: {
		select: {
			id: true,
			requestedAction: true,
			errorType: true,
			errorNote: true,
		},
	},
	CurrentTransaction: {
		select: {
			id: true,
			createdAt: true,
			updatedAt: true,
			txHash: true,
			status: true,
			fees: true,
			blockHeight: true,
			blockTime: true,
			previousOnChainState: true,
			newOnChainState: true,
			confirmations: true,
			utxoCount: true,
			withdrawalCount: true,
			assetMintOrBurnCount: true,
			redeemerCount: true,
			validContract: true,
			outputAmount: true,
		},
	},
} satisfies Prisma.PurchaseRequestInclude;

type PurchaseRequestResponseRecord = Prisma.PurchaseRequestGetPayload<{
	include: typeof purchaseRequestResponseInclude;
}>;

type RecordedBusinessMetricError = Error & { businessEndpointErrorRecorded?: boolean };

function createRecordedBusinessHttpError(
	statusCode: number,
	message: string,
	attributes: Record<string, string>,
): Error {
	recordBusinessEndpointError('/api/v1/purchase/x402', 'POST', statusCode, message, attributes);
	const error = createHttpError(statusCode, message) as RecordedBusinessMetricError;
	error.businessEndpointErrorRecorded = true;
	return error;
}

async function getCoinsPerUtxoSize(blockchainProvider: BlockfrostProvider) {
	let coinsPerUtxoSize: number = CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE;
	try {
		const params = await blockchainProvider.fetchProtocolParameters();
		if (params.coinsPerUtxoSize != null) {
			coinsPerUtxoSize = params.coinsPerUtxoSize;
		}
	} catch (e) {
		logger.warn('Could not fetch protocol parameters, using fallback for min-UTXO calculation', {
			error: e,
		});
	}
	return coinsPerUtxoSize;
}

function serializeX402PurchaseResponse(
	purchaseRequest: PurchaseRequestResponseRecord,
	agentIdentifier: string,
	unsignedTxCbor: string,
) {
	const timestamps = transformPurchaseGetTimestamps(purchaseRequest);
	const amounts = transformPurchaseGetAmounts(purchaseRequest);

	return {
		id: purchaseRequest.id,
		createdAt: purchaseRequest.createdAt,
		updatedAt: purchaseRequest.updatedAt,
		blockchainIdentifier: purchaseRequest.blockchainIdentifier,
		agentIdentifier,
		pricingType: purchaseRequest.pricingType,
		lastCheckedAt: purchaseRequest.lastCheckedAt,
		payByTime: timestamps.payByTime,
		submitResultTime: timestamps.submitResultTime,
		unlockTime: timestamps.unlockTime,
		externalDisputeUnlockTime: timestamps.externalDisputeUnlockTime,
		totalBuyerCardanoFees: Number(purchaseRequest.totalBuyerCardanoFees.toString()) / 1_000_000,
		totalSellerCardanoFees: Number(purchaseRequest.totalSellerCardanoFees.toString()) / 1_000_000,
		nextActionOrOnChainStateOrResultLastChangedAt: purchaseRequest.nextActionOrOnChainStateOrResultLastChangedAt,
		nextActionLastChangedAt: purchaseRequest.nextActionLastChangedAt,
		onChainStateOrResultLastChangedAt: purchaseRequest.onChainStateOrResultLastChangedAt,
		requestedById: purchaseRequest.requestedById,
		onChainState: purchaseRequest.onChainState,
		collateralReturnLovelace: timestamps.collateralReturnLovelace,
		cooldownTime: timestamps.cooldownTime,
		cooldownTimeOtherParty: timestamps.cooldownTimeOtherParty,
		inputHash: purchaseRequest.inputHash,
		resultHash: purchaseRequest.resultHash,
		NextAction: {
			requestedAction: purchaseRequest.NextAction.requestedAction,
			errorType: purchaseRequest.NextAction.errorType,
			errorNote: purchaseRequest.NextAction.errorNote,
		},
		CurrentTransaction:
			purchaseRequest.CurrentTransaction != null
				? {
						id: purchaseRequest.CurrentTransaction.id,
						createdAt: purchaseRequest.CurrentTransaction.createdAt,
						updatedAt: purchaseRequest.CurrentTransaction.updatedAt,
						txHash: purchaseRequest.CurrentTransaction.txHash,
						status: purchaseRequest.CurrentTransaction.status,
						fees: purchaseRequest.CurrentTransaction.fees?.toString() ?? null,
						blockHeight: purchaseRequest.CurrentTransaction.blockHeight,
						blockTime: purchaseRequest.CurrentTransaction.blockTime,
						previousOnChainState: purchaseRequest.CurrentTransaction.previousOnChainState,
						newOnChainState: purchaseRequest.CurrentTransaction.newOnChainState,
						confirmations: purchaseRequest.CurrentTransaction.confirmations,
					}
				: null,
		PaidFunds: amounts.PaidFunds,
		WithdrawnForSeller: amounts.WithdrawnForSeller,
		WithdrawnForBuyer: amounts.WithdrawnForBuyer,
		PaymentSource: purchaseRequest.PaymentSource,
		SellerWallet: purchaseRequest.SellerWallet,
		SmartContractWallet: purchaseRequest.SmartContractWallet,
		metadata: purchaseRequest.metadata,
		unsignedTxCbor,
	};
}

export const createX402PurchasePost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createX402PurchaseSchemaInput,
	output: createX402PurchaseSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createX402PurchaseSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

			const policyId = input.agentIdentifier.substring(0, 56);

			const paymentSource = await prisma.paymentSource.findFirst({
				where: { policyId, network: input.network, deletedAt: null },
				include: {
					PaymentSourceConfig: { select: { rpcProviderApiKey: true, rpcProvider: true } },
				},
			});

			const inputHash = input.inputHash;
			if (validateHexString(inputHash) == false) {
				throw createRecordedBusinessHttpError(400, 'Input hash is not a valid hex string', {
					network: input.network,
					field: 'inputHash',
					validation_type: 'invalid_hex_string',
				});
			}

			if (paymentSource == null) {
				throw createRecordedBusinessHttpError(404, 'No payment source found for agent identifiers policy id', {
					network: input.network,
					step: 'payment_source_lookup',
				});
			}

			// Idempotency: return existing purchase if already created
			const existingPurchaseRequest = await prisma.purchaseRequest.findFirst({
				where: {
					blockchainIdentifier: input.blockchainIdentifier,
					paymentSourceId: paymentSource.id,
				},
				include: purchaseRequestResponseInclude,
			});
			if (existingPurchaseRequest != null) {
				let unsignedTxCbor = '';
				const canRebuildUnsignedTx =
					existingPurchaseRequest.NextAction.requestedAction === PurchasingAction.ExternalFundsLockingInitiated &&
					existingPurchaseRequest.buyerWalletAddress != null &&
					existingPurchaseRequest.buyerWalletAddress === input.buyerAddress &&
					existingPurchaseRequest.CurrentTransaction == null;

				if (canRebuildUnsignedTx) {
					const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
					const coinsPerUtxoSize = await getCoinsPerUtxoSize(blockchainProvider);

					const rebuiltTransaction = await buildX402FundsLockingTransaction({
						purchaseRequestId: existingPurchaseRequest.id,
						buyerAddress: input.buyerAddress,
						blockchainProvider,
						network: input.network,
						scriptAddress: paymentSource.smartContractAddress,
						coinsPerUtxoSize,
						persistState: false,
					});
					unsignedTxCbor = rebuiltTransaction.unsignedTxCbor;
				}

				throw new HttpExistsError(
					'Purchase exists',
					existingPurchaseRequest.id,
					serializeX402PurchaseResponse(existingPurchaseRequest, input.agentIdentifier, unsignedTxCbor),
				);
			}

			const wallets = await prisma.hotWallet.aggregate({
				where: { paymentSourceId: paymentSource.id, type: HotWalletType.Selling, deletedAt: null },
				_count: true,
			});
			if (wallets._count === 0) {
				throw createRecordedBusinessHttpError(404, 'No valid purchasing wallets found', {
					network: input.network,
					wallet_type: 'selling',
					step: 'wallet_lookup',
				});
			}

			const additionalExternalDisputeUnlockTime = BigInt(1000 * 60 * 15);
			const submitResultTime = BigInt(input.submitResultTime);
			const payByTime = BigInt(input.payByTime);
			const unlockTime = BigInt(input.unlockTime);
			const externalDisputeUnlockTime = BigInt(input.externalDisputeUnlockTime);

			if (payByTime > submitResultTime - BigInt(1000 * 60 * 5)) {
				throw createRecordedBusinessHttpError(400, 'Pay by time must be before submit result time (min. 5 minutes)', {
					network: input.network,
					field: 'payByTime',
					validation_type: 'invalid_time_constraint',
					pay_by_time: payByTime.toString(),
					submit_result_time: submitResultTime.toString(),
				});
			}
			if (payByTime < BigInt(Date.now() - 1000 * 60 * 5)) {
				throw createRecordedBusinessHttpError(400, 'Pay by time must be in the future (max. 5 minutes)', {
					network: input.network,
					field: 'payByTime',
					validation_type: 'time_in_past',
					pay_by_time: payByTime.toString(),
					current_time: Date.now().toString(),
				});
			}
			if (externalDisputeUnlockTime < unlockTime + additionalExternalDisputeUnlockTime) {
				throw createHttpError(
					400,
					'External dispute unlock time must be after unlock time (min. 15 minutes difference)',
				);
			}
			if (submitResultTime < BigInt(Date.now() + 1000 * 60 * 15)) {
				throw createHttpError(400, 'Submit result time must be in the future (min. 15 minutes)');
			}
			const offset = BigInt(1000 * 60 * 15);
			if (submitResultTime > unlockTime - offset) {
				throw createHttpError(400, 'Submit result time must be before unlock time with at least 15 minutes difference');
			}

			const provider = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);

			const assetId = input.agentIdentifier;
			const policyAsset = assetId.startsWith(policyId) ? assetId : policyId + assetId;
			const assetInWallet = await provider.assetsAddresses(policyAsset, { order: 'desc', count: 1 });

			if (assetInWallet.length == 0) throw createHttpError(404, 'Agent identifier not found');
			const addressOfAsset = assetInWallet[0].address;
			if (addressOfAsset == null) throw createHttpError(404, 'Agent identifier not found');

			const vKey = resolvePaymentKeyHash(addressOfAsset);
			if (vKey != input.sellerVkey) throw createHttpError(400, 'Invalid seller vkey');

			const assetInfo = await provider.assetsById(assetId);
			if (!assetInfo.onchain_metadata) throw createHttpError(404, 'Agent identifier not found');

			const parsedMetadata = metadataSchema.safeParse(assetInfo.onchain_metadata);
			if (!parsedMetadata.success || !parsedMetadata.data) {
				logger.error('Error parsing metadata', { error: parsedMetadata.error });
				throw createHttpError(404, 'Agent identifier metadata invalid or unsupported');
			}

			const pricing = parsedMetadata.data.agentPricing;
			if (pricing.pricingType != PricingType.Fixed && pricing.pricingType != PricingType.Dynamic) {
				throw createHttpError(400, 'Agent identifier pricing type not supported');
			}

			const agentIdentifierAmountsMap = new Map<string, bigint>();
			if (pricing.pricingType == PricingType.Fixed) {
				const amounts = pricing.fixedPricing;
				for (const amount of amounts) {
					const unit = normalizePurchaseUnit(metadataToString(amount.unit)!);
					if (agentIdentifierAmountsMap.has(unit)) {
						agentIdentifierAmountsMap.set(unit, agentIdentifierAmountsMap.get(unit)! + BigInt(amount.amount));
					} else {
						agentIdentifierAmountsMap.set(unit, BigInt(amount.amount));
					}
				}
				if (input.Amounts != undefined) {
					const inputAmountsMap = new Map<string, bigint>();
					for (const amount of input.Amounts) {
						const unit = normalizePurchaseUnit(amount.unit);
						if (inputAmountsMap.has(unit)) {
							inputAmountsMap.set(unit, inputAmountsMap.get(unit)! + BigInt(amount.amount));
						} else {
							inputAmountsMap.set(unit, BigInt(amount.amount));
						}
					}
					if (inputAmountsMap.size != agentIdentifierAmountsMap.size) {
						throw createHttpError(400, 'Provided Amounts do not match the fixed pricing of the agent');
					}
					for (const [unit, amount] of agentIdentifierAmountsMap) {
						if (inputAmountsMap.get(unit) != amount) {
							throw createHttpError(400, 'Provided Amounts do not match the fixed pricing of the agent');
						}
					}
				}
			} else {
				if (input.Amounts == undefined || input.Amounts.length == 0) {
					throw createHttpError(400, 'For dynamic pricing, Amounts must be provided');
				}
				for (const fund of input.Amounts) {
					if (BigInt(fund.amount) <= 0n) throw createHttpError(400, 'Amounts must be positive');
				}
				for (const amount of input.Amounts) {
					const unit = normalizePurchaseUnit(amount.unit);
					if (agentIdentifierAmountsMap.has(unit)) {
						agentIdentifierAmountsMap.set(unit, agentIdentifierAmountsMap.get(unit)! + BigInt(amount.amount));
					} else {
						agentIdentifierAmountsMap.set(unit, BigInt(amount.amount));
					}
				}
			}

			const decoded = decodeBlockchainIdentifier(input.blockchainIdentifier);
			if (decoded == null) throw createHttpError(400, 'Invalid blockchain identifier, format invalid');

			const purchaserId = decoded.purchaserId;
			const sellerId = decoded.sellerId;
			const signature = decoded.signature;
			const key = decoded.key;

			if (purchaserId != input.identifierFromPurchaser) {
				throw createHttpError(400, 'Invalid blockchain identifier, purchaser id mismatch');
			}
			if (validateHexString(purchaserId) == false) {
				throw createHttpError(400, 'Purchaser identifier is not a valid hex string');
			}
			if (validateHexString(sellerId) == false) {
				throw createHttpError(400, 'Seller identifier is not a valid hex string');
			}
			if (decoded.agentIdentifier != input.agentIdentifier) {
				throw createHttpError(400, 'Invalid blockchain identifier, agent identifier mismatch');
			}

			const cosePublicKey = getPublicKeyFromCoseKey(key);
			if (cosePublicKey == null) throw createHttpError(400, 'Invalid blockchain identifier, key not found');

			const publicKeyHash = cosePublicKey.hash();
			if (publicKeyHash.hex() != input.sellerVkey) {
				throw createHttpError(400, 'Invalid blockchain identifier, key does not match');
			}

			const reconstructedBlockchainIdentifier = {
				inputHash: input.inputHash,
				agentIdentifier: input.agentIdentifier,
				purchaserIdentifier: purchaserId,
				sellerIdentifier: sellerId,
				RequestedFunds:
					pricing.pricingType == PricingType.Dynamic && input.Amounts
						? input.Amounts.map((a) => ({
								amount: a.amount,
								unit: a.unit.toLowerCase() == 'lovelace' ? '' : a.unit,
							}))
						: null,
				payByTime: input.payByTime,
				submitResultTime: input.submitResultTime,
				unlockTime: unlockTime.toString(),
				externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
				sellerAddress: addressOfAsset,
			};

			const hashedBlockchainIdentifier = generateSHA256Hash(stringify(reconstructedBlockchainIdentifier));
			const identifierIsSignedCorrectly = await checkSignature(hashedBlockchainIdentifier, {
				signature,
				key,
			});
			if (!identifierIsSignedCorrectly) {
				throw createHttpError(400, 'Invalid blockchain identifier, signature invalid');
			}

			const smartContractAddress = paymentSource.smartContractAddress;
			const requestedCost = Array.from(agentIdentifierAmountsMap.entries()).map(([unit, amount]) => ({
				amount,
				unit: unit.toLowerCase() == 'lovelace' ? '' : unit,
			}));
			const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
			const coinsPerUtxoSize = await getCoinsPerUtxoSize(blockchainProvider);

			const builtTransaction = await buildX402FundsLockingTransaction({
				purchaseRequestData: {
					blockchainIdentifier: input.blockchainIdentifier,
					inputHash: input.inputHash,
					payByTime,
					submitResultTime,
					unlockTime,
					externalDisputeUnlockTime,
					sellerAddress: addressOfAsset,
					paidFunds: requestedCost,
				},
				buyerAddress: input.buyerAddress,
				blockchainProvider,
				network: input.network,
				scriptAddress: smartContractAddress,
				coinsPerUtxoSize,
				persistState: false,
			});

			// Create purchase request in DB (same as regular purchase)
			const initialPurchaseRequest = await handlePurchaseCreditInit({
				id: ctx.id,
				walletScopeIds: ctx.walletScopeIds,
				cost: requestedCost,
				metadata: input.metadata,
				network: input.network,
				blockchainIdentifier: input.blockchainIdentifier,
				contractAddress: smartContractAddress,
				sellerVkey: input.sellerVkey,
				sellerAddress: addressOfAsset,
				payByTime,
				submitResultTime,
				unlockTime,
				externalDisputeUnlockTime,
				inputHash: input.inputHash,
				pricingType: pricing.pricingType,
			});
			await prisma.purchaseRequest.update({
				where: { id: initialPurchaseRequest.id },
				data: {
					...connectPreviousAction(initialPurchaseRequest.nextActionId),
					...createNextPurchaseAction(PurchasingAction.ExternalFundsLockingInitiated),
					collateralReturnLovelace: builtTransaction.collateralReturnLovelace,
					buyerWalletAddress: input.buyerAddress,
					buyerWalletVkey: builtTransaction.buyerWalletVkey,
				},
			});

			const updatedPurchaseRequest = await prisma.purchaseRequest.findUnique({
				where: { id: initialPurchaseRequest.id },
				include: purchaseRequestResponseInclude,
			});
			if (updatedPurchaseRequest == null) {
				throw createHttpError(500, 'Purchase request not found after x402 transaction build');
			}

			return serializeX402PurchaseResponse(
				updatedPurchaseRequest,
				input.agentIdentifier,
				builtTransaction.unsignedTxCbor,
			);
		} catch (error: unknown) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const wasBusinessMetricAlreadyRecorded =
				(errorInstance as RecordedBusinessMetricError).businessEndpointErrorRecorded === true;
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			if (!wasBusinessMetricAlreadyRecorded) {
				recordBusinessEndpointError('/api/v1/purchase/x402', 'POST', statusCode, errorInstance, {
					network: input.network,
					user_id: ctx.id,
					agent_identifier: input.agentIdentifier,
					duration: Date.now() - startTime,
					step: 'x402_purchase_processing',
				});
			}
			throw error;
		}
	},
});
