import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { InsufficientFundsError } from '@/utils/errors/insufficient-funds-error';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { Network, PricingType, PurchasingAction, WalletBase, WalletType } from '@/generated/prisma/client';
import { withSerializableSlotRetry } from '@/utils/db/serializable-semaphore';

async function handlePurchaseCreditInit({
	id,
	walletScopeIds,
	cost,
	metadata,
	network,
	blockchainIdentifier,
	contractAddress,
	sellerVkey,
	sellerAddress,
	payByTime,
	submitResultTime,
	unlockTime,
	externalDisputeUnlockTime,
	inputHash,
	pricingType,
	collateralReturnLovelace,
	buyerReturnAddress,
	sellerReturnAddress,
}: {
	id: string;
	walletScopeIds: string[] | null;
	cost: Array<{ amount: bigint; unit: string }>;
	metadata: string | null | undefined;
	network: Network;
	blockchainIdentifier: string;
	contractAddress: string;
	sellerVkey: string;
	sellerAddress: string;
	payByTime: bigint;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	inputHash: string;
	pricingType: PricingType;
	collateralReturnLovelace?: bigint;
	buyerReturnAddress?: string | null;
	sellerReturnAddress?: string | null;
}) {
	// Gate Serializable $transaction through the shared semaphore so concurrent
	// HTTP requests don't exhaust the pg connection pool. See
	// `src/utils/db/serializable-semaphore.ts`.
	return await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (prisma) => {
					const paymentSource = await prisma.paymentSource.findUnique({
						where: {
							network_smartContractAddress: {
								network: network,
								smartContractAddress: contractAddress,
							},
							deletedAt: null,
						},
					});
					if (!paymentSource) {
						throw createHttpError(
							400,
							'Invalid paymentSource: ' + JSON.stringify({ network, smartContractAddress: contractAddress }),
						);
					}
					let sellerWallet: WalletBase | null = await prisma.walletBase.findUnique({
						where: {
							paymentSourceId_walletVkey_walletAddress_type: {
								paymentSourceId: paymentSource.id,
								walletVkey: sellerVkey,
								walletAddress: sellerAddress,
								type: WalletType.Seller,
							},
						},
					});

					const result = await prisma.apiKey.findUnique({
						where: { id: id },
						include: {
							RemainingUsageCredits: true,
						},
					});
					if (!result) {
						throw createHttpError(404, 'Invalid id: ' + id);
					}
					if (!result.canAdmin && !result.networkLimit.includes(network)) {
						throw createHttpError(403, 'No permission for network: ' + network + ' for id: ' + id);
					}

					if (!sellerWallet) {
						sellerWallet = await prisma.walletBase.create({
							data: {
								walletVkey: sellerVkey,
								walletAddress: sellerAddress,
								type: WalletType.Seller,
								PaymentSource: { connect: { id: paymentSource.id } },
							},
						});
					}

					const remainingAccumulatedUsageCredits: Map<string, bigint> = new Map<string, bigint>();

					// Sum up all purchase amounts
					result.RemainingUsageCredits.forEach((request) => {
						if (!remainingAccumulatedUsageCredits.has(request.unit)) {
							remainingAccumulatedUsageCredits.set(request.unit, 0n);
						}
						remainingAccumulatedUsageCredits.set(
							request.unit,
							remainingAccumulatedUsageCredits.get(request.unit)! + request.amount,
						);
					});

					const totalCost: Map<string, bigint> = new Map<string, bigint>();
					cost.forEach((amount) => {
						if (!totalCost.has(amount.unit)) {
							totalCost.set(amount.unit, 0n);
						}
						totalCost.set(amount.unit, totalCost.get(amount.unit)! + amount.amount);
					});
					const newRemainingUsageCredits: Map<string, bigint> = remainingAccumulatedUsageCredits;

					if (result.usageLimited) {
						for (const [unit, amount] of totalCost) {
							if (!newRemainingUsageCredits.has(unit)) {
								throw new InsufficientFundsError('Credit unit not found: ' + unit + ' for id: ' + id);
							}
							newRemainingUsageCredits.set(unit, newRemainingUsageCredits.get(unit)! - amount);
							if (newRemainingUsageCredits.get(unit)! < 0) {
								throw new InsufficientFundsError('Not enough ' + unit + ' tokens to handleCreditUsage for id: ' + id);
							}
						}
					}

					// Create new usage amount records with unique IDs
					const updatedUsageAmounts = Array.from(newRemainingUsageCredits.entries()).map(([unit, amount]) => ({
						id: `${id}-${unit}`, // Create a unique ID
						amount: amount,
						unit: unit,
					}));
					if (result.usageLimited) {
						await prisma.apiKey.update({
							where: { id: id },
							data: {
								RemainingUsageCredits: {
									set: updatedUsageAmounts,
								},
							},
						});
					}

					const agentIdentifier = decodeBlockchainIdentifier(blockchainIdentifier)?.agentIdentifier ?? null;

					const purchaseRequest = await prisma.purchaseRequest.create({
						data: {
							totalBuyerCardanoFees: BigInt(0),
							totalSellerCardanoFees: BigInt(0),
							pricingType: pricingType,
							requestedBy: { connect: { id: id } },
							PaidFunds: {
								create: Array.from(totalCost.entries()).map(([unit, amount]) => ({
									amount: amount,
									unit: unit,
								})),
							},
							payByTime: payByTime,
							submitResultTime: submitResultTime,
							PaymentSource: { connect: { id: paymentSource.id } },
							resultHash: null,
							sellerCoolDownTime: 0,
							buyerCoolDownTime: 0,
							SellerWallet: {
								connect: { id: sellerWallet.id },
							},
							blockchainIdentifier: blockchainIdentifier,
							agentIdentifier,
							agentIdentifierSyncedAt: new Date(),
							inputHash: inputHash,
							NextAction: {
								create: {
									requestedAction: PurchasingAction.FundsLockingRequested,
								},
							},
							externalDisputeUnlockTime: externalDisputeUnlockTime,
							unlockTime: unlockTime,
							collateralReturnLovelace,
							buyerReturnAddress,
							sellerReturnAddress,
							metadata: metadata,
							isLimitedToHotWallets: walletScopeIds !== null,
							...(walletScopeIds !== null && walletScopeIds.length > 0
								? { HotWalletLimit: { connect: walletScopeIds.map((wId) => ({ id: wId })) } }
								: {}),
						},
						include: {
							SellerWallet: { select: { id: true, walletVkey: true } },
							SmartContractWallet: {
								where: { deletedAt: null },
								select: { id: true, walletVkey: true, walletAddress: true },
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
							PaidFunds: { select: { amount: true, unit: true } },
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
									txHash: true,
									status: true,
									confirmations: true,
									fees: true,
									blockHeight: true,
									blockTime: true,
								},
							},
							WithdrawnForSeller: {
								select: { id: true, amount: true, unit: true },
							},
							WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
						},
					});

					return purchaseRequest;
				},
				{ isolationLevel: 'Serializable', maxWait: 10_000, timeout: 10_000 },
			),
		// HTTP-path retry budget. The default helper budget (8 retries × up to
		// 5 s backoff) is too long for a synchronous HTTP request, but the
		// previous 3-retry / 500 ms cap was too SHORT under Serializable
		// isolation: two near-simultaneous POSTs targeting the same `apiKey`
		// row would deterministically lose the second to `40001 serialization
		// failure` because the total backoff budget (jittered ~700 ms across
		// 3 attempts) gave conflict resolution no real headroom. Bumped to
		// 6 retries with a 1 s max delay — typical happy path still settles
		// in 1-2 attempts (<1 s), pathological contention now amortises over
		// ~3.5 s of jittered backoff (~10-15 s total wall-clock worst case
		// including the 10 s inner timeout), still within any reasonable
		// HTTP-request budget. Inner $transaction timeout stays at 10 s; the
		// credit-init tx is small and shouldn't need 30 s of wall-clock.
		{
			label: 'credit-repository-purchase-init',
			maxRetries: 6,
			maxDelayMs: 1000,
		},
	);
}

export const creditTokenRepository = { handlePurchaseCreditInit };
