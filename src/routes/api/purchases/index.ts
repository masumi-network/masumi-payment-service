import { z } from '@masumi/payment-core/zod';
import { HotWalletType, PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { validateHexString } from '@/utils/validator/hex';
import { handlePurchaseCreditInit } from '@/services/integrations';
import { HttpExistsError } from '@masumi/payment-core/http-exists-error';
import { recordBusinessEndpointError } from '@masumi/payment-core/metrics';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { resolvePurchaseCreationContext } from './shared';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import {
	createPurchaseInitSchemaInput,
	createPurchaseInitSchemaOutput,
	purchaseResponseSchema,
	queryPurchaseCountSchemaInput,
	queryPurchaseCountSchemaOutput,
	queryPurchaseRequestSchemaInput,
	queryPurchaseRequestSchemaOutput,
} from './schemas';
import { getPurchasesForQuery, resolvePurchasePaymentSourceTypeFilter } from './queries';
import { serializePurchasesResponse } from './serializers';
import { isCardanoPubKeyBaseAddressForNetwork } from '@/types/payment-source';

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
					paymentSourceType: resolvePurchasePaymentSourceTypeFilter(input),
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
					// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
					// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER.
					totalBuyerCardanoFees: lovelaceToAdaNumberSafe(existingPurchaseRequest.totalBuyerCardanoFees),
					totalSellerCardanoFees: lovelaceToAdaNumberSafe(existingPurchaseRequest.totalSellerCardanoFees),
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
			const explicitSmartContractAddress =
				input.smartContractAddress != null && input.smartContractAddress.length > 0 ? input.smartContractAddress : null;

			const decodedBlockchainIdentifier = decodeBlockchainIdentifier(input.blockchainIdentifier);
			if (decodedBlockchainIdentifier == null) {
				throw createHttpError(400, 'Invalid blockchain identifier, format invalid');
			}
			const inferredPaymentSourceType =
				decodedBlockchainIdentifier.smartContractAddress != null
					? PaymentSourceType.Web3CardanoV2
					: PaymentSourceType.Web3CardanoV1;
			if (input.paymentSourceType != null && input.paymentSourceType !== inferredPaymentSourceType) {
				throw createHttpError(400, 'Payment source type does not match the blockchain identifier');
			}

			const resolvedPaymentSourceType = input.paymentSourceType ?? inferredPaymentSourceType;
			const isV2 = resolvedPaymentSourceType === PaymentSourceType.Web3CardanoV2;
			const v2SmartContractAddress = decodedBlockchainIdentifier.smartContractAddress;

			const paymentSource = await (async () => {
				if (isV2) {
					if (v2SmartContractAddress == null) {
						throw createHttpError(400, 'Invalid blockchain identifier, V2 must carry smartContractAddress');
					}
					if (explicitSmartContractAddress != null && explicitSmartContractAddress !== v2SmartContractAddress) {
						throw createHttpError(400, 'Invalid blockchain identifier, smartContractAddress mismatch');
					}
					return prisma.paymentSource.findFirst({
						where: {
							network: input.network,
							smartContractAddress: v2SmartContractAddress,
							policyId: policyId,
							paymentSourceType: PaymentSourceType.Web3CardanoV2,
							deletedAt: null,
						},
						include: {
							PaymentSourceConfig: {
								select: { rpcProviderApiKey: true, rpcProvider: true },
							},
						},
					});
				}

				return prisma.paymentSource.findFirst({
					where: {
						policyId: policyId,
						network: input.network,
						paymentSourceType: resolvedPaymentSourceType,
						deletedAt: null,
					},
					include: {
						PaymentSourceConfig: {
							select: { rpcProviderApiKey: true, rpcProvider: true },
						},
					},
				});
			})();
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
					isV2
						? 'No configured V2 payment source found for smartContractAddress'
						: 'No payment source found for agent identifiers policy id',
					{
						network: input.network,
						policy_id: policyId,
						smart_contract_address: isV2 ? (v2SmartContractAddress ?? '') : (explicitSmartContractAddress ?? ''),
						agent_identifier: input.agentIdentifier,
						step: 'payment_source_lookup',
					},
				);
				throw createHttpError(
					404,
					isV2
						? 'No configured V2 payment source found for smartContractAddress'
						: 'No payment source found for agent identifiers policy id',
				);
			}
			if (paymentSource.paymentSourceType !== resolvedPaymentSourceType) {
				throw createHttpError(400, 'Payment source type does not match the agent identifier policy');
			}

			const wallets = await prisma.hotWallet.aggregate({
				where: {
					paymentSourceId: paymentSource.id,
					type: HotWalletType.Purchasing,
					deletedAt: null,
				},
				_count: true,
			});
			if (wallets._count === 0) {
				recordBusinessEndpointError('/api/v1/purchase', 'POST', 404, 'No valid purchasing wallets found', {
					network: input.network,
					payment_source_id: paymentSource.id,
					wallet_type: 'purchasing',
					step: 'wallet_lookup',
				});
				throw createHttpError(404, 'No valid purchasing wallets found');
			}
			const {
				externalDisputeUnlockTime,
				payByTime,
				pricingType,
				requestedCost,
				sellerAddress,
				sellerReturnAddress,
				submitResultTime,
				unlockTime,
			} = await resolvePurchaseCreationContext({
				input: {
					...input,
					paymentSourceType: paymentSource.paymentSourceType,
				},
				paymentSourceId: paymentSource.id,
				rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
				smartContractAddress: paymentSource.smartContractAddress,
			});
			const smartContractAddress = paymentSource.smartContractAddress;
			if (isV2) {
				if (
					input.buyerReturnAddress != null &&
					!isCardanoPubKeyBaseAddressForNetwork(input.buyerReturnAddress, input.network)
				) {
					throw createHttpError(400, 'buyerReturnAddress must be a Cardano base address with a stake credential');
				}
				if (sellerReturnAddress != null && !isCardanoPubKeyBaseAddressForNetwork(sellerReturnAddress, input.network)) {
					throw createHttpError(400, 'sellerReturnAddress must be a Cardano base address with a stake credential');
				}
			}
			// V2 contract trap: `address_to_verification_key(seller)` returns None
			// for script-credential addresses. The `sellerAddress` resolved above
			// is the on-chain holder of the agent NFT — if a seller transferred
			// their NFT to a script-credential address, every contract redeemer
			// referencing the seller principal would fail and funds locked
			// against this seller would be permanently unspendable. Reject
			// before constructing the purchase request.
			if (isV2 && !isCardanoPubKeyBaseAddressForNetwork(sellerAddress, input.network)) {
				throw createHttpError(
					400,
					'Seller principal address (resolved from agent NFT holder) must be a Cardano base address with a verification-key payment credential. Script-credential addresses (smart wallets, multisig wrappers) cannot interact with the escrow contract; the seller must move the agent NFT to a verification-key address before purchases can be processed.',
				);
			}

			const initialPurchaseRequest = await handlePurchaseCreditInit({
				id: ctx.id,
				walletScopeIds: ctx.walletScopeIds,
				cost: requestedCost,
				metadata: input.metadata,
				network: input.network,
				blockchainIdentifier: input.blockchainIdentifier,
				contractAddress: smartContractAddress,
				sellerVkey: input.sellerVkey,
				sellerAddress,
				payByTime,
				submitResultTime,
				unlockTime,
				externalDisputeUnlockTime,
				inputHash: input.inputHash,
				pricingType,
				buyerReturnAddress: input.buyerReturnAddress ?? null,
				sellerReturnAddress,
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
