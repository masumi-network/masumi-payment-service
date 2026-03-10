import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { HotWalletType, PaymentAction, PricingType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { createId } from '@paralleldrive/cuid2';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import stringify from 'canonical-json';
import { fetchAssetInWalletAndMetadata } from '@/services/blockchain/asset-metadata';
import {
	decodeBlockchainIdentifier,
	generateBlockchainIdentifier,
} from '@/utils/generator/blockchain-identifier-generator';
import { validateHexString } from '@/utils/validator/hex';
import { transformPaymentGetAmounts, transformPaymentGetTimestamps } from '@/utils/shared/transformers';
import { extractPolicyId } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
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
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.canAdmin);

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
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.canAdmin);

		const total = await prisma.paymentRequest.count({
			where: {
				PaymentSource: {
					network: input.network,
					smartContractAddress: input.filterSmartContractAddress ?? undefined,
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
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.canAdmin);
		const policyId = extractPolicyId(input.agentIdentifier);

		const specifiedPaymentContract = await prisma.paymentSource.findFirst({
			where: {
				network: input.network,
				policyId: policyId,
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
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.canAdmin);
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
		const pricing = parsedMetadata.agentPricing;
		if (pricing.pricingType == PricingType.Fixed && input.RequestedFunds != null) {
			throw createHttpError(400, 'For fixed pricing, RequestedFunds must be null');
		} else if (pricing.pricingType != PricingType.Fixed) {
			throw createHttpError(400, 'Non fixed price not supported yet');
		}

		const amounts = pricing.fixedPricing.map((amount) => ({
			amount: amount.amount,
			unit: metadataToString(amount.unit)?.toLowerCase() == 'lovelace' ? '' : metadataToString(amount.unit)!,
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
		const sellerCUID = createId();
		const sellerId = generateSHA256Hash(sellerCUID) + input.agentIdentifier;
		const blockchainIdentifier = {
			inputHash: input.inputHash,
			agentIdentifier: input.agentIdentifier,
			purchaserIdentifier: input.identifierFromPurchaser,
			sellerIdentifier: sellerId,
			//RequestedFunds: is null for fixed pricing
			RequestedFunds: null,
			payByTime: input.payByTime.getTime().toString(),
			submitResultTime: input.submitResultTime.getTime().toString(),
			unlockTime: unlockTime.toString(),
			externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
			sellerAddress: sellingWallet.walletAddress,
		};

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
		);

		const payment = await prisma.paymentRequest.create({
			data: {
				totalBuyerCardanoFees: BigInt(0),
				totalSellerCardanoFees: BigInt(0),
				blockchainIdentifier: compressedEncodedBlockchainIdentifier,
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
			totalBuyerCardanoFees: Number(payment.totalBuyerCardanoFees.toString()) / 1_000_000,
			totalSellerCardanoFees: Number(payment.totalSellerCardanoFees.toString()) / 1_000_000,
			agentIdentifier: decodeBlockchainIdentifier(payment.blockchainIdentifier)?.agentIdentifier ?? null,
			CurrentTransaction: payment.CurrentTransaction
				? {
						...payment.CurrentTransaction,
						fees: payment.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
		};
	},
});
