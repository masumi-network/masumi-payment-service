import { prisma } from '@masumi/payment-core/db';
import { OnChainState, PaymentAction, Prisma, PurchasingAction, TransactionStatus } from '@/generated/prisma/client';
// TODO(v1-package-boundary): move logic/state-transitions and db/retry to @masumi/payment-core
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from '@/utils/logic/state-transitions';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { TransactionMetadata } from '@/services/transactions/tx-sync/blockchain';

export async function handleV1PaymentTransaction(
	tx_hash: string,
	newState: OnChainState,
	paymentContractId: string,
	blockchainIdentifier: string,
	resultHash: string | null,
	currentAction: PaymentAction,
	buyerCooldownTime: bigint,
	sellerCooldownTime: bigint,
	sellerWithdrawn: Array<{ unit: string; quantity: bigint }>,
	buyerWithdrawn: Array<{ unit: string; quantity: bigint }>,
	confirmations: number,
	metadata: TransactionMetadata,
	buyerCardanoFees: bigint,
	sellerCardanoFees: bigint,
) {
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (prisma) => {
					//we dont need to do sanity checks as the tx hash is unique
					const paymentRequest = await prisma.paymentRequest.findUnique({
						where: {
							paymentSourceId: paymentContractId,
							blockchainIdentifier: blockchainIdentifier,
						},
						include: {
							CurrentTransaction: { include: { BlocksWallet: true } },
							NextAction: true,
						},
					});

					if (paymentRequest == null) {
						//transaction is not registered with us or a payment transaction
						return;
					}

					// Idempotency: if this exact tx was already fully applied to this
					// request (same CurrentTransaction.txHash, status Confirmed, and
					// onChainState already at the target newState), skip. Multi-redeemer
					// txs can re-enter this handler when a sibling entry in the same tx
					// triggers a retry of the whole tx — without this guard the rerun
					// would double-write ActionHistory + NextAction.
					if (
						paymentRequest.CurrentTransaction?.txHash === tx_hash &&
						paymentRequest.CurrentTransaction?.status === TransactionStatus.Confirmed &&
						paymentRequest.onChainState === newState
					) {
						return;
					}

					const newAction = convertNewPaymentActionAndError(currentAction, newState);

					const isConfirmationTransaction =
						paymentRequest.currentTransactionId && paymentRequest.CurrentTransaction?.txHash == tx_hash;

					await prisma.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							totalBuyerCardanoFees: { increment: buyerCardanoFees },
							totalSellerCardanoFees: { increment: sellerCardanoFees },
							ActionHistory: {
								connect: {
									id: paymentRequest.nextActionId,
								},
							},
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote:
										paymentRequest.NextAction.errorNote != null
											? paymentRequest.NextAction.errorNote +
												'(' +
												paymentRequest.NextAction.requestedAction +
												')' +
												' -> ' +
												newAction.errorNote
											: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							TransactionHistory: !isConfirmationTransaction
								? {
										connect: { id: paymentRequest.currentTransactionId! },
									}
								: undefined,
							CurrentTransaction: isConfirmationTransaction
								? {
										update: {
											txHash: tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: confirmations,
											previousOnChainState: paymentRequest.onChainState,
											newOnChainState: newState,
											fees: metadata.fees,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									}
								: {
										create: {
											txHash: tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: confirmations,
											previousOnChainState: paymentRequest.onChainState,
											newOnChainState: newState,
											fees: metadata.fees,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									},
							WithdrawnForSeller: sellerWithdrawn
								? {
										createMany: {
											data: sellerWithdrawn.map((sw) => {
												return { unit: sw.unit, amount: sw.quantity };
											}),
										},
									}
								: undefined,
							WithdrawnForBuyer: buyerWithdrawn
								? {
										createMany: {
											data: buyerWithdrawn.map((bw) => {
												return { unit: bw.unit, amount: bw.quantity };
											}),
										},
									}
								: undefined,
							buyerCoolDownTime: buyerCooldownTime,
							sellerCoolDownTime: sellerCooldownTime,
							onChainState: newState,
							resultHash: resultHash,
						},
					});
					if (paymentRequest.currentTransactionId != null && paymentRequest.CurrentTransaction?.BlocksWallet != null) {
						await prisma.transaction.update({
							where: {
								id: paymentRequest.currentTransactionId,
							},
							data: { BlocksWallet: { disconnect: true } },
						});
						await prisma.hotWallet.update({
							where: {
								id: paymentRequest.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: { lockedAt: null },
						});
					}
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-handle-0' },
	);
}

export async function handleV1PurchasingTransaction(
	tx_hash: string,
	newStatus: OnChainState,
	paymentContractId: string,
	blockchainIdentifier: string,
	resultHash: string | null,
	currentAction: PurchasingAction,
	buyerCooldownTime: bigint,
	sellerCooldownTime: bigint,
	sellerWithdrawn: Array<{ unit: string; quantity: bigint }>,
	buyerWithdrawn: Array<{ unit: string; quantity: bigint }>,
	confirmations: number,
	metadata: TransactionMetadata,
	buyerCardanoFees: bigint,
	sellerCardanoFees: bigint,
) {
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (prisma) => {
					//we dont need to do sanity checks as the tx hash is unique
					const purchasingRequest = await prisma.purchaseRequest.findUnique({
						where: {
							paymentSourceId: paymentContractId,
							blockchainIdentifier: blockchainIdentifier,
						},
						include: {
							CurrentTransaction: { include: { BlocksWallet: true } },
							NextAction: true,
						},
					});

					if (purchasingRequest == null) {
						//transaction is not registered with us as a purchasing transaction
						return;
					}

					// Idempotency: skip if this tx was already fully applied. See
					// the matching guard in handleV1PaymentTransaction for the
					// multi-redeemer rationale.
					if (
						purchasingRequest.CurrentTransaction?.txHash === tx_hash &&
						purchasingRequest.CurrentTransaction?.status === TransactionStatus.Confirmed &&
						purchasingRequest.onChainState === newStatus
					) {
						return;
					}

					const newAction = convertNewPurchasingActionAndError(currentAction, newStatus);
					const isConfirmationTransaction =
						purchasingRequest.currentTransactionId && purchasingRequest.CurrentTransaction?.txHash == tx_hash;

					await prisma.purchaseRequest.update({
						where: { id: purchasingRequest.id },
						data: {
							totalBuyerCardanoFees: { increment: buyerCardanoFees },
							totalSellerCardanoFees: { increment: sellerCardanoFees },
							inputHash: purchasingRequest.inputHash,
							ActionHistory: {
								connect: {
									id: purchasingRequest.nextActionId,
								},
							},
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote:
										purchasingRequest.NextAction.errorNote != null
											? purchasingRequest.NextAction.errorNote +
												'(' +
												purchasingRequest.NextAction.requestedAction +
												')' +
												' -> ' +
												newAction.errorNote
											: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							TransactionHistory: !isConfirmationTransaction
								? {
										connect: { id: purchasingRequest.currentTransactionId! },
									}
								: undefined,
							CurrentTransaction: isConfirmationTransaction
								? {
										update: {
											txHash: tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: confirmations,
											previousOnChainState: purchasingRequest.onChainState,
											newOnChainState: newStatus,
											fees: metadata.fees,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									}
								: {
										create: {
											txHash: tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: confirmations,
											previousOnChainState: purchasingRequest.onChainState,
											newOnChainState: newStatus,
											fees: metadata.fees,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									},
							WithdrawnForSeller: sellerWithdrawn
								? {
										createMany: {
											data: sellerWithdrawn.map((sw) => {
												return { unit: sw.unit, amount: sw.quantity };
											}),
										},
									}
								: undefined,
							WithdrawnForBuyer: buyerWithdrawn
								? {
										createMany: {
											data: buyerWithdrawn.map((bw) => {
												return { unit: bw.unit, amount: bw.quantity };
											}),
										},
									}
								: undefined,
							buyerCoolDownTime: buyerCooldownTime,
							sellerCoolDownTime: sellerCooldownTime,
							onChainState: newStatus,
							resultHash: resultHash,
						},
					});
					if (
						purchasingRequest.currentTransactionId != null &&
						purchasingRequest.CurrentTransaction?.BlocksWallet != null
					) {
						await prisma.transaction.update({
							where: {
								id: purchasingRequest.currentTransactionId,
							},
							data: { BlocksWallet: { disconnect: true } },
						});
						await prisma.hotWallet.update({
							where: {
								id: purchasingRequest.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: { lockedAt: null },
						});
					}
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-handle-1' },
	);
}
