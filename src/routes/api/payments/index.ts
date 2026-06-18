import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { HotWalletType, PaymentAction, PaymentSourceType, PricingType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { HttpExistsError } from '@masumi/payment-core/http-exists-error';
import { createId } from '@paralleldrive/cuid2';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import stringify from 'canonical-json';
import { fetchAssetInWalletAndMetadata } from '@/services/integrations/asset-metadata';
import { resolveAgentPricingFromMetadata } from '@/routes/api/registry/wallet';
import { decodeBlockchainIdentifier, generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { buildSignedBlockchainIdentifierPayload } from '@/utils/generator/blockchain-identifier-payload';
import { validateHexString } from '@/utils/validator/hex';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { transformPaymentGetAmounts, transformPaymentGetTimestamps } from '@/utils/shared/transformers';
import { resolveTransactionAgentName } from '@/utils/shared/resolve-transaction-agent-name';
import { extractPolicyId } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { buildWalletScopeFilter, assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import {
	createPaymentSchemaOutput,
	createPaymentsSchemaInput,
	paymentResponseSchema,
	queryPaymentCountSchemaInput,
	queryPaymentCountSchemaOutput,
	queryPaymentsSchemaInput,
	queryPaymentsSchemaOutput,
} from './schemas';
import { getPaymentsForQuery } from './queries';
import { serializePaymentsResponse } from './serializers';
import { isCardanoPubKeyBaseAddressForNetwork } from '@/types/payment-source';

export {
	createPaymentSchemaOutput,
	createPaymentsSchemaInput,
	paymentResponseSchema,
	queryPaymentCountSchemaInput,
	queryPaymentCountSchemaOutput,
	queryPaymentsSchemaInput,
	queryPaymentsSchemaOutput,
};
export const queryPaymentEntryGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryPaymentsSchemaInput,
	output: queryPaymentsSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryPaymentsSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const result = await getPaymentsForQuery(input, ctx.walletScopeIds);
		if (result == null) {
			throw createHttpError(404, 'Payment not found');
		}

		return serializePaymentsResponse(result);
	},
});

export const queryPaymentCountGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryPaymentCountSchemaInput,
	output: queryPaymentCountSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryPaymentCountSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const total = await prisma.paymentRequest.count({
			where: {
				PaymentSource: {
					network: input.network,
					smartContractAddress: input.filterSmartContractAddress ?? undefined,
					paymentSourceType: input.filterPaymentSourceType,
					deletedAt: null,
				},
				...buildWalletScopeFilter(ctx.walletScopeIds),
			},
		});

		return {
			total,
		};
	},
});

export const paymentInitPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createPaymentsSchemaInput,
	output: createPaymentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createPaymentsSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const policyId = extractPolicyId(input.agentIdentifier);

		const specifiedPaymentContract = await prisma.paymentSource.findFirst({
			where: {
				network: input.network,
				policyId: policyId,
				paymentSourceType: input.paymentSourceType,
				deletedAt: null,
			},
			include: {
				PaymentSourceConfig: {
					select: { rpcProviderApiKey: true, rpcProvider: true },
				},
			},
		});
		if (specifiedPaymentContract == null) {
			throw createHttpError(404, 'Network and policyId combination not supported');
		}
		// No post-fetch paymentSourceType guard needed: when the caller supplies
		// `input.paymentSourceType`, the `findFirst` above already filters by
		// that exact value, so a mismatching row cannot be returned. Active-row
		// uniqueness on `(network, policyId)` is enforced by the partial unique
		// index `PaymentSource_network_policyId_active_key` (migration
		// 20260519120000_add_payment_source_type_v2_registry_metadata), so the
		// lookup is deterministic even when `paymentSourceType` is omitted.
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const purchaserId = input.identifierFromPurchaser;
		if (validateHexString(purchaserId) == false) {
			throw createHttpError(400, 'Purchaser identifier is not a valid hex string');
		}
		const inputHash = input.inputHash;
		if (validateHexString(inputHash) == false) {
			throw createHttpError(400, 'Input hash is not a valid hex string');
		}

		const payByTime = BigInt(input.payByTime.getTime());
		const submitResultTime = BigInt(input.submitResultTime.getTime());

		const unlockTime =
			input.unlockTime != undefined
				? input.unlockTime.getTime()
				: new Date(input.submitResultTime.getTime() + 1000 * 60 * 60 * 6).getTime(); // default +6h

		const externalDisputeUnlockTime =
			input.externalDisputeUnlockTime != undefined
				? input.externalDisputeUnlockTime.getTime()
				: new Date(input.submitResultTime.getTime() + 1000 * 60 * 60 * 12).getTime(); // default +12h

		//require at least 3 hours between unlock time and the submit result time
		const additionalExternalDisputeUnlockTime = BigInt(1000 * 60 * 15);

		if (payByTime > submitResultTime - BigInt(1000 * 60 * 5)) {
			throw createHttpError(400, 'Pay by time must be before submit result time (min. 5 minutes)');
		}
		if (payByTime < BigInt(Date.now() - 1000 * 60 * 5)) {
			throw createHttpError(400, 'Pay by time must be in the future (max. 5 minutes)');
		}

		if (externalDisputeUnlockTime < BigInt(unlockTime) + additionalExternalDisputeUnlockTime) {
			throw createHttpError(400, 'External dispute unlock time must be after unlock time (min. 15 minutes difference)');
		}
		if (submitResultTime < BigInt(Date.now() + 1000 * 60 * 15)) {
			throw createHttpError(400, 'Submit result time must be in the future (min. 15 minutes)');
		}
		const offset = BigInt(1000 * 60 * 15);
		if (submitResultTime > BigInt(unlockTime) - offset) {
			throw createHttpError(400, 'Submit result time must be before unlock time with at least 15 minutes difference');
		}

		const provider = getBlockfrostInstance(
			input.network,
			specifiedPaymentContract.PaymentSourceConfig.rpcProviderApiKey,
		);

		if (input.agentIdentifier.startsWith(policyId) == false) {
			throw createHttpError(404, 'The agentIdentifier is not of the specified payment source');
		}
		const fetchResult = await fetchAssetInWalletAndMetadata(provider, input.agentIdentifier);
		if ('error' in fetchResult) {
			throw createHttpError(fetchResult.error.code, fetchResult.error.description);
		}

		const { assetInWallet, parsedMetadata } = fetchResult.data;
		const pricing = resolveAgentPricingFromMetadata(parsedMetadata);
		if (pricing == null) {
			throw createHttpError(400, 'Agent metadata does not advertise any pricing');
		}
		if (pricing.pricingType == PricingType.Fixed && input.RequestedFunds != null) {
			throw createHttpError(400, 'For fixed pricing, RequestedFunds must be null');
		} else if (
			pricing.pricingType == PricingType.Dynamic &&
			(input.RequestedFunds == null || input.RequestedFunds.length == 0)
		) {
			throw createHttpError(400, 'For dynamic pricing, RequestedFunds must be provided');
		} else if (pricing.pricingType != PricingType.Fixed && pricing.pricingType != PricingType.Dynamic) {
			throw createHttpError(400, 'Pricing type not supported for payments');
		}

		if (pricing.pricingType == PricingType.Dynamic && input.RequestedFunds) {
			for (const fund of input.RequestedFunds) {
				if (BigInt(fund.amount) <= 0n) {
					throw createHttpError(400, 'RequestedFunds amounts must be positive');
				}
			}
		}

		const amounts =
			pricing.pricingType == PricingType.Fixed
				? pricing.fixedPricing.map((amount) => ({
						amount: amount.amount,
						unit: metadataToString(amount.unit)?.toLowerCase() == 'lovelace' ? '' : metadataToString(amount.unit)!,
					}))
				: input.RequestedFunds!.map((fund) => ({
						amount: fund.amount,
						unit: fund.unit.toLowerCase() == 'lovelace' ? '' : fund.unit,
					}));

		const vKey = resolvePaymentKeyHash(assetInWallet[0].address);

		const sellingWallet = await prisma.hotWallet.findFirst({
			where: {
				deletedAt: null,
				type: HotWalletType.Selling,
				walletVkey: vKey,
				paymentSourceId: specifiedPaymentContract.id,
			},
			include: {
				Secret: {
					select: { encryptedMnemonic: true },
				},
			},
		});
		if (sellingWallet == null) {
			throw createHttpError(404, 'Selling wallet not found');
		}
		assertHotWalletInScope(ctx.walletScopeIds, sellingWallet.id);
		const sellerReturnAddress = input.sellerReturnAddress ?? sellingWallet.collectionAddress;
		const isV2 = specifiedPaymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2;
		if (
			isV2 &&
			sellerReturnAddress != null &&
			!isCardanoPubKeyBaseAddressForNetwork(sellerReturnAddress, input.network)
		) {
			throw createHttpError(400, 'sellerReturnAddress must be a Cardano base address with a stake credential');
		}
		const sellerCUID = createId();
		const sellerId = generateSHA256Hash(sellerCUID) + input.agentIdentifier;
		const blockchainIdentifier = buildSignedBlockchainIdentifierPayload({
			inputHash: input.inputHash,
			agentIdentifier: input.agentIdentifier,
			purchaserIdentifier: input.identifierFromPurchaser,
			sellerIdentifier: sellerId,
			requestedFunds:
				pricing.pricingType == PricingType.Dynamic
					? amounts.map((amount) => ({
							amount: amount.amount.toString(),
							unit: amount.unit,
						}))
					: null,
			payByTime: input.payByTime.getTime().toString(),
			submitResultTime: input.submitResultTime.getTime().toString(),
			unlockTime: unlockTime.toString(),
			externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
			sellerAddress: sellingWallet.walletAddress,
			sellerReturnAddress,
			smartContractAddress: isV2 ? specifiedPaymentContract.smartContractAddress : null,
			paymentSourceType: specifiedPaymentContract.paymentSourceType,
		});

		const meshWallet = new MeshWallet({
			networkId: convertNetworkToId(input.network),
			key: {
				type: 'mnemonic',
				words: decrypt(sellingWallet.Secret.encryptedMnemonic).split(' '),
			},
		});

		const hashedBlockchainIdentifier = generateSHA256Hash(stringify(blockchainIdentifier));
		const signedBlockchainIdentifier = await meshWallet.signData(
			hashedBlockchainIdentifier,
			sellingWallet.walletAddress,
		);

		const compressedEncodedBlockchainIdentifier = generateBlockchainIdentifier(
			signedBlockchainIdentifier.key,
			signedBlockchainIdentifier.signature,
			sellerId,
			input.identifierFromPurchaser,
			isV2 ? specifiedPaymentContract.smartContractAddress : null,
		);

		// Idempotency: PaymentRequest.blockchainIdentifier is @unique in the
		// schema, so duplicate POSTs with identical inputs would otherwise
		// surface a raw Prisma P2002 as an opaque 500. Mirror the purchase
		// route's HttpExistsError pattern (purchases/index.ts:88-194): if a
		// row with this exact blockchainIdentifier already exists, return it
		// with HttpExistsError so the caller can pick up the in-flight
		// payment rather than crash on retry.
		const existingPaymentRequest = await prisma.paymentRequest.findUnique({
			where: {
				blockchainIdentifier: compressedEncodedBlockchainIdentifier,
				PaymentSource: { deletedAt: null, network: input.network },
			},
			include: {
				BuyerWallet: { select: { id: true, walletVkey: true } },
				SmartContractWallet: {
					where: { deletedAt: null },
					select: { id: true, walletVkey: true, walletAddress: true },
				},
				RequestedFunds: { select: { id: true, amount: true, unit: true } },
				NextAction: {
					select: {
						id: true,
						requestedAction: true,
						errorType: true,
						errorNote: true,
						resultHash: true,
					},
				},
				PaymentSource: {
					select: {
						id: true,
						network: true,
						paymentSourceType: true,
						smartContractAddress: true,
						policyId: true,
					},
				},
				CurrentTransaction: {
					select: {
						id: true,
						createdAt: true,
						updatedAt: true,
						fees: true,
						blockHeight: true,
						blockTime: true,
						txHash: true,
						status: true,
						previousOnChainState: true,
						newOnChainState: true,
						confirmations: true,
					},
				},
				WithdrawnForSeller: { select: { id: true, amount: true, unit: true } },
				WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
			},
		});
		if (existingPaymentRequest != null) {
			const decoded = decodeBlockchainIdentifier(existingPaymentRequest.blockchainIdentifier);
			// Spread + transformer overrides produce a JSON-safe shape (BigInt
			// fields converted to strings). HttpExistsError's `allowedObject`
			// type is too narrow to express the structural-merge result, so
			// cast to `any` (same pattern used by the purchase route's
			// HttpExistsError call at purchases/index.ts:132).
			const serialized = {
				...existingPaymentRequest,
				...transformPaymentGetTimestamps(existingPaymentRequest),
				...transformPaymentGetAmounts(existingPaymentRequest),
				// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
				// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER.
				totalBuyerCardanoFees: lovelaceToAdaNumberSafe(existingPaymentRequest.totalBuyerCardanoFees),
				totalSellerCardanoFees: lovelaceToAdaNumberSafe(existingPaymentRequest.totalSellerCardanoFees),
				agentIdentifier: decoded?.agentIdentifier ?? null,
				CurrentTransaction: existingPaymentRequest.CurrentTransaction
					? {
							...existingPaymentRequest.CurrentTransaction,
							fees: existingPaymentRequest.CurrentTransaction.fees?.toString() ?? null,
						}
					: null,
			};
			// `as never` to bypass HttpExistsError's narrow `allowedObject`
			// constraint — the merged shape is JSON-safe after the transformer
			// overrides above, but TS can't structurally prove it. The
			// purchase route uses the same pragmatic shape.
			throw new HttpExistsError('Payment exists', existingPaymentRequest.id, serialized as never);
		}

		const agentName = await resolveTransactionAgentName({
			agentIdentifier: input.agentIdentifier,
			onChainName: metadataToString(parsedMetadata.name),
		});

		const payment = await prisma.paymentRequest.create({
			data: {
				totalBuyerCardanoFees: BigInt(0),
				totalSellerCardanoFees: BigInt(0),
				pricingType: pricing.pricingType,
				blockchainIdentifier: compressedEncodedBlockchainIdentifier,
				agentIdentifier: input.agentIdentifier,
				agentIdentifierSyncedAt: new Date(),
				agentName,
				agentNameSyncedAt: new Date(),
				PaymentSource: { connect: { id: specifiedPaymentContract.id } },
				RequestedFunds: {
					createMany: {
						data: amounts.map((amount) => {
							return { amount: BigInt(amount.amount), unit: amount.unit };
						}),
					},
				},
				NextAction: {
					create: {
						requestedAction: PaymentAction.WaitingForExternalAction,
					},
				},
				inputHash: input.inputHash,
				resultHash: '',
				SmartContractWallet: {
					connect: { id: sellingWallet.id, deletedAt: null },
				},
				payByTime: input.payByTime.getTime(),
				submitResultTime: input.submitResultTime.getTime(),
				unlockTime: unlockTime,
				externalDisputeUnlockTime: externalDisputeUnlockTime,
				sellerReturnAddress,
				buyerReturnAddress: null,
				sellerCoolDownTime: 0,
				buyerCoolDownTime: 0,
				requestedBy: { connect: { id: ctx.id } },
				metadata: input.metadata,
			},
			include: {
				BuyerWallet: { select: { id: true, walletVkey: true } },
				SmartContractWallet: {
					where: { deletedAt: null },
					select: { id: true, walletVkey: true, walletAddress: true },
				},
				RequestedFunds: { select: { id: true, amount: true, unit: true } },
				NextAction: {
					select: {
						id: true,
						requestedAction: true,
						errorType: true,
						errorNote: true,
						resultHash: true,
					},
				},
				PaymentSource: {
					select: {
						id: true,
						network: true,
						paymentSourceType: true,
						smartContractAddress: true,
						policyId: true,
					},
				},
				CurrentTransaction: {
					select: {
						id: true,
						createdAt: true,
						updatedAt: true,
						fees: true,
						blockHeight: true,
						blockTime: true,
						txHash: true,
						status: true,
						previousOnChainState: true,
						newOnChainState: true,
						confirmations: true,
					},
				},
				WithdrawnForSeller: {
					select: { id: true, amount: true, unit: true },
				},
				WithdrawnForBuyer: {
					select: { id: true, amount: true, unit: true },
				},
			},
		});
		if (payment.SmartContractWallet == null) {
			throw createHttpError(500, 'Smart contract wallet not connected');
		}

		return {
			...payment,
			...transformPaymentGetTimestamps(payment),
			...transformPaymentGetAmounts(payment),
			// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
			// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER.
			totalBuyerCardanoFees: lovelaceToAdaNumberSafe(payment.totalBuyerCardanoFees),
			totalSellerCardanoFees: lovelaceToAdaNumberSafe(payment.totalSellerCardanoFees),
			agentIdentifier:
				payment.agentIdentifier ?? decodeBlockchainIdentifier(payment.blockchainIdentifier)?.agentIdentifier ?? null,
			CurrentTransaction: payment.CurrentTransaction
				? {
						...payment.CurrentTransaction,
						fees: payment.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
		};
	},
});
