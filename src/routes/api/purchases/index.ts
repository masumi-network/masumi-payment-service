import { z } from '@/utils/zod-openapi';
import { HotWalletType, PricingType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { checkSignature, resolvePaymentKeyHash } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { metadataSchema } from '../registry/wallet';
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
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import {
	createPurchaseInitSchemaInput,
	createPurchaseInitSchemaOutput,
	purchaseResponseSchema,
	queryPurchaseCountSchemaInput,
	queryPurchaseCountSchemaOutput,
	queryPurchaseRequestSchemaInput,
	queryPurchaseRequestSchemaOutput,
} from './schemas';
import { getPurchasesForQuery } from './queries';
import { serializePurchasesResponse } from './serializers';

export {
	createPurchaseInitSchemaInput,
	createPurchaseInitSchemaOutput,
	purchaseResponseSchema,
	queryPurchaseCountSchemaInput,
	queryPurchaseCountSchemaOutput,
	queryPurchaseRequestSchemaInput,
	queryPurchaseRequestSchemaOutput,
};

export const queryPurchaseRequestGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryPurchaseRequestSchemaInput,
	output: queryPurchaseRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryPurchaseRequestSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const result = await getPurchasesForQuery(input, ctx.walletScopeIds);
		if (result == null) {
			throw createHttpError(404, 'Purchase not found');
		}
		return serializePurchasesResponse(result);
	},
});

export const queryPurchaseCountGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryPurchaseCountSchemaInput,
	output: queryPurchaseCountSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryPurchaseCountSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const total = await prisma.purchaseRequest.count({
			where: {
				PaymentSource: {
					deletedAt: null,
					network: input.network,
					smartContractAddress: input.filterSmartContractAddress ?? undefined,
				},
				...buildWalletScopeFilter(ctx.walletScopeIds),
			},
		});

		return {
			total,
		};
	},
});

export const createPurchaseInitPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createPurchaseInitSchemaInput,
	output: createPurchaseInitSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createPurchaseInitSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
			const existingPurchaseRequest = await prisma.purchaseRequest.findUnique({
				where: {
					blockchainIdentifier: input.blockchainIdentifier,
					PaymentSource: {
						deletedAt: null,
						network: input.network,
					},
				},
				include: {
					SellerWallet: { select: { id: true, walletVkey: true } },
					SmartContractWallet: {
						where: { deletedAt: null },
						select: { id: true, walletVkey: true, walletAddress: true },
					},
					WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
					WithdrawnForSeller: {
						select: { id: true, amount: true, unit: true },
					},
					PaidFunds: { select: { id: true, amount: true, unit: true } },
					NextAction: true,
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
				},
			});
			if (existingPurchaseRequest != null) {
				throw new HttpExistsError('Purchase exists', existingPurchaseRequest.id, {
					...existingPurchaseRequest,
					totalBuyerCardanoFees: Number(existingPurchaseRequest.totalBuyerCardanoFees.toString()) / 1_000_000,
					totalSellerCardanoFees: Number(existingPurchaseRequest.totalSellerCardanoFees.toString()) / 1_000_000,
					CurrentTransaction: existingPurchaseRequest.CurrentTransaction
						? {
								id: existingPurchaseRequest.CurrentTransaction.id,
								createdAt: existingPurchaseRequest.CurrentTransaction.createdAt,
								updatedAt: existingPurchaseRequest.CurrentTransaction.updatedAt,
								txHash: existingPurchaseRequest.CurrentTransaction.txHash,
								status: existingPurchaseRequest.CurrentTransaction.status,
								fees: existingPurchaseRequest.CurrentTransaction.fees?.toString() ?? null,
								blockHeight: existingPurchaseRequest.CurrentTransaction.blockHeight,
								blockTime: existingPurchaseRequest.CurrentTransaction.blockTime,
								utxoCount: existingPurchaseRequest.CurrentTransaction.utxoCount,
								withdrawalCount: existingPurchaseRequest.CurrentTransaction.withdrawalCount,
								assetMintOrBurnCount: existingPurchaseRequest.CurrentTransaction.assetMintOrBurnCount,
								redeemerCount: existingPurchaseRequest.CurrentTransaction.redeemerCount,
								validContract: existingPurchaseRequest.CurrentTransaction.validContract,
								outputAmount: existingPurchaseRequest.CurrentTransaction.outputAmount,
							}
						: null,
					TransactionHistory: [],
					payByTime: existingPurchaseRequest.payByTime?.toString() ?? null,
					PaidFunds: (
						existingPurchaseRequest.PaidFunds as Array<{
							unit: string;
							amount: bigint;
						}>
					).map((amount) => ({
						...amount,
						amount: amount.amount.toString(),
					})),
					WithdrawnForSeller: (
						existingPurchaseRequest.WithdrawnForSeller as Array<{
							unit: string;
							amount: bigint;
						}>
					).map((amount) => ({
						...amount,
						amount: amount.amount.toString(),
					})),
					WithdrawnForBuyer: (
						existingPurchaseRequest.WithdrawnForBuyer as Array<{
							unit: string;
							amount: bigint;
						}>
					).map((amount) => ({
						...amount,
						amount: amount.amount.toString(),
					})),
					submitResultTime: existingPurchaseRequest.submitResultTime.toString(),
					unlockTime: existingPurchaseRequest.unlockTime.toString(),
					externalDisputeUnlockTime: existingPurchaseRequest.externalDisputeUnlockTime.toString(),
					cooldownTime: Number(existingPurchaseRequest.buyerCoolDownTime),
					cooldownTimeOtherParty: Number(existingPurchaseRequest.sellerCoolDownTime),
					collateralReturnLovelace: existingPurchaseRequest.collateralReturnLovelace?.toString() ?? null,
					metadata: existingPurchaseRequest.metadata,
					buyerCoolDownTime: existingPurchaseRequest.buyerCoolDownTime.toString(),
					sellerCoolDownTime: existingPurchaseRequest.sellerCoolDownTime.toString(),
				});
			}
			const policyId = input.agentIdentifier.substring(0, 56);

			const paymentSource = await prisma.paymentSource.findFirst({
				where: {
					policyId: policyId,
					network: input.network,
					deletedAt: null,
				},
				include: {
					PaymentSourceConfig: {
						select: { rpcProviderApiKey: true, rpcProvider: true },
					},
				},
			});
			const inputHash = input.inputHash;
			if (validateHexString(inputHash) == false) {
				recordBusinessEndpointError('/api/v1/purchase', 'POST', 400, 'Input hash is not a valid hex string', {
					network: input.network,
					field: 'inputHash',
					validation_type: 'invalid_hex_string',
				});
				throw createHttpError(400, 'Input hash is not a valid hex string');
			}

			if (paymentSource == null) {
				recordBusinessEndpointError(
					'/api/v1/purchase',
					'POST',
					404,
					'No payment source found for agent identifiers policy id',
					{
						network: input.network,
						policy_id: policyId,
						agent_identifier: input.agentIdentifier,
						step: 'payment_source_lookup',
					},
				);
				throw createHttpError(404, 'No payment source found for agent identifiers policy id');
			}

			const wallets = await prisma.hotWallet.aggregate({
				where: {
					paymentSourceId: paymentSource.id,
					type: HotWalletType.Selling,
					deletedAt: null,
				},
				_count: true,
			});
			if (wallets._count === 0) {
				recordBusinessEndpointError('/api/v1/purchase', 'POST', 404, 'No valid purchasing wallets found', {
					network: input.network,
					payment_source_id: paymentSource.id,
					wallet_type: 'selling',
					step: 'wallet_lookup',
				});
				throw createHttpError(404, 'No valid purchasing wallets found');
			}
			//require at least 3 hours between unlock time and the submit result time
			const additionalExternalDisputeUnlockTime = BigInt(1000 * 60 * 15);
			const submitResultTime = BigInt(input.submitResultTime);
			const payByTime = BigInt(input.payByTime);
			const unlockTime = BigInt(input.unlockTime);
			const externalDisputeUnlockTime = BigInt(input.externalDisputeUnlockTime);
			if (payByTime > submitResultTime - BigInt(1000 * 60 * 5)) {
				recordBusinessEndpointError(
					'/api/v1/purchase',
					'POST',
					400,
					'Pay by time must be before submit result time (min. 5 minutes)',
					{
						network: input.network,
						field: 'payByTime',
						validation_type: 'invalid_time_constraint',
						pay_by_time: payByTime.toString(),
						submit_result_time: submitResultTime.toString(),
					},
				);
				throw createHttpError(400, 'Pay by time must be before submit result time (min. 5 minutes)');
			}
			if (payByTime < BigInt(Date.now() - 1000 * 60 * 5)) {
				recordBusinessEndpointError(
					'/api/v1/purchase',
					'POST',
					400,
					'Pay by time must be in the future (max. 5 minutes)',
					{
						network: input.network,
						field: 'payByTime',
						validation_type: 'time_in_past',
						pay_by_time: payByTime.toString(),
						current_time: Date.now().toString(),
					},
				);
				throw createHttpError(400, 'Pay by time must be in the future (max. 5 minutes)');
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
			const assetInWallet = await provider.assetsAddresses(policyAsset, {
				order: 'desc',
				count: 1,
			});

			if (assetInWallet.length == 0) {
				throw createHttpError(404, 'Agent identifier not found');
			}
			const addressOfAsset = assetInWallet[0].address;
			if (addressOfAsset == null) {
				throw createHttpError(404, 'Agent identifier not found');
			}

			const vKey = resolvePaymentKeyHash(addressOfAsset);
			if (vKey != input.sellerVkey) {
				throw createHttpError(400, 'Invalid seller vkey');
			}

			const assetInfo = await provider.assetsById(assetId);
			if (!assetInfo.onchain_metadata) {
				throw createHttpError(404, 'Agent identifier not found');
			}
			const parsedMetadata = metadataSchema.safeParse(assetInfo.onchain_metadata);

			if (!parsedMetadata.success || !parsedMetadata.data) {
				const error = parsedMetadata.error;
				logger.error('Error parsing metadata', { error });
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
				// If Amounts are provided for fixed pricing, verify they match
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
					if (BigInt(fund.amount) <= 0n) {
						throw createHttpError(400, 'Amounts must be positive');
					}
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
			if (decoded == null) {
				throw createHttpError(400, 'Invalid blockchain identifier, format invalid');
			}
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
			if (cosePublicKey == null) {
				throw createHttpError(400, 'Invalid blockchain identifier, key not found');
			}
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
				signature: signature,
				key: key,
			});
			if (!identifierIsSignedCorrectly) {
				throw createHttpError(400, 'Invalid blockchain identifier, signature invalid');
			}
			const smartContractAddress = paymentSource.smartContractAddress;

			const initialPurchaseRequest = await handlePurchaseCreditInit({
				id: ctx.id,
				walletScopeIds: ctx.walletScopeIds,
				cost: Array.from(agentIdentifierAmountsMap.entries()).map(([unit, amount]) => {
					if (unit.toLowerCase() == 'lovelace') {
						return { amount: amount, unit: '' };
					} else {
						return { amount: amount, unit: unit };
					}
				}),
				metadata: input.metadata,
				network: input.network,
				blockchainIdentifier: input.blockchainIdentifier,
				contractAddress: smartContractAddress,
				sellerVkey: input.sellerVkey,
				sellerAddress: addressOfAsset,
				payByTime: payByTime,
				submitResultTime: submitResultTime,
				unlockTime: unlockTime,
				externalDisputeUnlockTime: externalDisputeUnlockTime,
				inputHash: input.inputHash,
				pricingType: pricing.pricingType,
			});

			return {
				...initialPurchaseRequest,
				...transformPurchaseGetTimestamps(initialPurchaseRequest),
				...transformPurchaseGetAmounts(initialPurchaseRequest),
				totalBuyerCardanoFees: 0,
				totalSellerCardanoFees: 0,
				agentIdentifier: input.agentIdentifier,
				CurrentTransaction: null,
			};
		} catch (error: unknown) {
			// Record the business-specific error with context
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/purchase', 'POST', statusCode, errorInstance, {
				network: input.network,
				user_id: ctx.id,
				agent_identifier: input.agentIdentifier,
				duration: Date.now() - startTime,
				step: 'purchase_processing',
			});

			throw error;
		}
	},
});
