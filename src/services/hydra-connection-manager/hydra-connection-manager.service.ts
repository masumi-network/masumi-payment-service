import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { CustomHydraHead, HydraProvider, HydraHeadEvent, HydraNodeEvent, StatusChangeData } from '@/lib/hydra';
import {
	HydraHeadStatus,
	Network,
	OnChainState,
	PaymentAction,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from '@/utils/logic/state-transitions';
import { CONSTANTS } from '@/utils/config';
import { deriveExpectedOnChainState } from '@/services/hydra-tx-handler/derive-state';
import { HydraHeadUpdateInput } from '@/generated/prisma/models';
import { HydraNodeConfig } from '@/lib/hydra/hydra/types';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { deserializeDatum } from '@meshsdk/core';
import { decodeV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { checkPaymentAmountsMatch } from '@/services/transactions/tx-sync/util';

interface ManagedHead {
	head: CustomHydraHead;
	provider: HydraProvider;
	hydraHeadId: string;
}

export interface HydraHeadWithLocalParticipant {
	id: string;
	LocalParticipant: {
		walletId: string;
		nodeHttpUrl: string;
		nodeUrl: string;
	} | null;
}

export class HydraConnectionManager {
	private _heads: Map<string, ManagedHead> = new Map();
	private _reconnectTimers: Map<string, number> = new Map();
	private _processingTxIds: Set<string> = new Set();

	async initialize(): Promise<void> {
		const enabledHeads = await prisma.hydraHead.findMany({
			where: { isEnabled: true },
			include: { LocalParticipant: true },
		});

		logger.info(`[HydraConnectionManager] Found ${enabledHeads.length} enabled heads to check`);

		for (const head of enabledHeads) {
			if (!head.LocalParticipant) {
				logger.warn(`[HydraConnectionManager] Head ${head.id} has no local participant, skipping`);
				continue;
			}

			try {
				await this.connect(head);
			} catch (error) {
				logger.warn(`[HydraConnectionManager] Failed to connect to head ${head.id}`, {
					error,
				});
			}
		}

		logger.info(`[HydraConnectionManager] Initialization complete, connected to ${this._heads.size} heads`);
	}

	async connect(head: HydraHeadWithLocalParticipant): Promise<void> {
		if (this._heads.has(head.id)) {
			logger.info(`[HydraConnectionManager] Already connected to head ${head.id}`);
			return;
		}

		if (!head.LocalParticipant) {
			throw new Error('No local participant provided');
		}

		const isReachable = await this.probeNode(head.LocalParticipant.nodeHttpUrl);
		if (!isReachable) {
			throw new Error(`Local Hydra node unreachable for head ${head.id}`);
		}

		const nodeConfig: HydraNodeConfig = {
			httpUrl: head.LocalParticipant.nodeHttpUrl,
			walletId: head.LocalParticipant.walletId,
		};

		const hydraHead = new CustomHydraHead([nodeConfig]);
		await hydraHead.connect(head.LocalParticipant.walletId);

		const provider = new HydraProvider({ node: hydraHead.mainNode });

		this.setupEventHandlers(head.id, hydraHead);

		this._heads.set(head.id, {
			head: hydraHead,
			provider,
			hydraHeadId: head.id,
		});
		logger.info(
			`[HydraConnectionManager] Connected to head ${head.id}` +
				` via local node at ${head.LocalParticipant.nodeHttpUrl}`,
		);
	}

	disconnect(hydraHeadId: string): void {
		const managed = this._heads.get(hydraHeadId);
		if (!managed) {
			return;
		}

		managed.head.removeAllListeners();
		managed.head.mainNode.removeAllListeners();
		this._heads.delete(hydraHeadId);

		const reconnectTimer = this._reconnectTimers.get(hydraHeadId);
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			this._reconnectTimers.delete(hydraHeadId);
		}

		logger.info(`[HydraConnectionManager] Disconnected from head ${hydraHeadId}`);
	}

	getHead(hydraHeadId: string): CustomHydraHead | null {
		return this._heads.get(hydraHeadId)?.head ?? null;
	}

	getNode(hydraHeadId: string): HydraNode | null {
		const managed = this._heads.get(hydraHeadId);
		if (!managed) return null;
		return managed.head.mainNode;
	}

	getProvider(hydraHeadId: string): HydraProvider | null {
		return this._heads.get(hydraHeadId)?.provider ?? null;
	}

	get connectedHeadIds(): string[] {
		return Array.from(this._heads.keys());
	}

	isConnected(hydraHeadId: string): boolean {
		return this._heads.has(hydraHeadId);
	}

	async shutdown(): Promise<void> {
		logger.info('[HydraConnectionManager] Shutting down all connections');
		for (const [headId] of this._heads) {
			this.disconnect(headId);
		}
	}

	private async probeNode(httpUrl: string, timeoutMs = 5000): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			await fetch(`${httpUrl}/protocol-parameters`, {
				signal: controller.signal,
				headers: { 'Content-Type': 'application/json' },
			});
			clearTimeout(timeout);
			return true;
		} catch {
			return false;
		}
	}

	private setupEventHandlers(hydraHeadId: string, head: CustomHydraHead): void {
		head.on(HydraHeadEvent.StatusChange, (data: StatusChangeData) => {
			void (async () => {
				const { status, headId, contestationDeadline, snapshotNumber } = data;
				logger.info(`[HydraConnectionManager] Head ${hydraHeadId} status changed to ${status}`, {
					headId,
					contestationDeadline,
					snapshotNumber,
				});

				try {
					const updateData: HydraHeadUpdateInput = {
						status,
						latestActivityAt: new Date(),
					};

					if (headId) {
						updateData.headId = headId;
					}

					if (contestationDeadline) {
						updateData.contestationDeadline = new Date(contestationDeadline);
					}

					if (snapshotNumber) {
						updateData.latestSnapshotNumber = BigInt(snapshotNumber);
					}

					if (status === HydraHeadStatus.Open) {
						updateData.openedAt = new Date();
					} else if (status === HydraHeadStatus.Closed) {
						updateData.closedAt = new Date();
					} else if (status === HydraHeadStatus.Final) {
						updateData.finalizedAt = new Date();
						this.disconnect(hydraHeadId);
					}

					await prisma.hydraHead.update({
						where: { id: hydraHeadId },
						data: updateData,
					});
				} catch (error) {
					logger.error('[HydraConnectionManager] Failed to update head status', {
						hydraHeadId,
						error,
					});
				}
			})();
		});

		head.mainNode.on(HydraNodeEvent.TxConfirmed, (txId: string) => {
			void (async () => {
				try {
					await this.handleTxConfirmed(hydraHeadId, txId);
				} catch (error) {
					logger.error('[HydraConnectionManager] Error handling confirmed tx', {
						txId,
						hydraHeadId,
						error,
					});
				}
			})();
		});
	}

	private async handleTxConfirmed(hydraHeadId: string, txId: string): Promise<void> {
		const dedupeKey = `${hydraHeadId}:${txId}`;
		if (this._processingTxIds.has(dedupeKey)) {
			logger.debug(`[HydraConnectionManager] Skipping duplicate TxConfirmed for ${txId}`);
			return;
		}
		this._processingTxIds.add(dedupeKey);

		try {
			await this._handleTxConfirmedInner(hydraHeadId, txId);
		} finally {
			this._processingTxIds.delete(dedupeKey);
		}
	}

	private async _handleTxConfirmedInner(hydraHeadId: string, txId: string): Promise<void> {
		const tx = await prisma.transaction.findFirst({
			where: {
				txHash: txId,
				layer: 'L2',
				hydraHeadId,
				status: TransactionStatus.Pending,
			},
			include: {
				PaymentRequestCurrent: {
					include: { NextAction: true },
				},
				PurchaseRequestCurrent: {
					include: { NextAction: true },
				},
				BlocksWallet: true,
			},
		});

		if (!tx) {
			await this.syncHydraDatumStateFromConfirmedTx(hydraHeadId, txId);
			return;
		}

		logger.info(`[HydraConnectionManager] Event-driven confirmation for L2 tx ${txId} in head ${hydraHeadId}`);

		if (tx.PaymentRequestCurrent) {
			const req = tx.PaymentRequestCurrent;
			const newState = deriveExpectedOnChainState(req.NextAction.requestedAction, req.onChainState);
			if (!newState) return;

			const newAction = convertNewPaymentActionAndError(req.NextAction.requestedAction, newState);

			await prisma.$transaction(
				async (prisma) => {
					await prisma.transaction.update({
						where: { id: tx.id },
						data: {
							status: TransactionStatus.Confirmed,
							previousOnChainState: req.onChainState,
							newOnChainState: newState,
							...(tx.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
						},
					});
					await prisma.paymentRequest.update({
						where: { id: req.id },
						data: {
							onChainState: newState,
							ActionHistory: { connect: { id: req.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
						},
					});
					if (tx.BlocksWallet) {
						await prisma.hotWallet.update({
							where: { id: tx.BlocksWallet.id, deletedAt: null },
							data: { lockedAt: null },
						});
					}
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
					maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
				},
			);
		}

		if (tx.PurchaseRequestCurrent) {
			const req = tx.PurchaseRequestCurrent;
			const newState = deriveExpectedOnChainState(req.NextAction.requestedAction, req.onChainState);
			if (!newState) return;

			const newAction = convertNewPurchasingActionAndError(req.NextAction.requestedAction, newState);

			await prisma.$transaction(
				async (prisma) => {
					await prisma.transaction.update({
						where: { id: tx.id },
						data: {
							status: TransactionStatus.Confirmed,
							previousOnChainState: req.onChainState,
							newOnChainState: newState,
							...(tx.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
						},
					});
					await prisma.purchaseRequest.update({
						where: { id: req.id },
						data: {
							onChainState: newState,
							ActionHistory: { connect: { id: req.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
						},
					});
					if (tx.BlocksWallet) {
						await prisma.hotWallet.update({
							where: { id: tx.BlocksWallet.id, deletedAt: null },
							data: { lockedAt: null },
						});
					}
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
					maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
				},
			);
		}
	}

	private async syncHydraDatumStateFromConfirmedTx(hydraHeadId: string, txId: string): Promise<void> {
		try {
			const provider = this.getProvider(hydraHeadId);
			if (!provider) {
				return;
			}

			const hydraHead = await prisma.hydraHead.findUnique({
				where: { id: hydraHeadId },
				include: {
					HydraRelation: {
						include: {
							LocalHotWallet: {
								include: {
									PaymentSource: true,
								},
							},
						},
					},
				},
			});

			if (!hydraHead) {
				return;
			}

			const paymentSource = hydraHead.HydraRelation.LocalHotWallet.PaymentSource;
			const network = paymentSource.network === Network.Mainnet ? 'mainnet' : 'preprod';
			const utxos = await provider.fetchUTxOs(txId);

			const contractOutputs = utxos.filter((utxo) => {
				return utxo.output.address === paymentSource.smartContractAddress && utxo.output.plutusData != null;
			});

			for (const output of contractOutputs) {
				const outputDatum = output.output.plutusData;
				if (!outputDatum) {
					continue;
				}

				const decodedDatum: unknown = deserializeDatum(outputDatum);
				const decodedNewContract = decodeV1ContractDatum(decodedDatum, network);
				const derivedOnChainState = this.deriveOnChainStateFromDatum(decodedNewContract);
				if (!decodedNewContract || !derivedOnChainState) {
					continue;
				}

				await this.applyDatumStateToLocalRequests({
					hydraHeadId,
					txId,
					paymentSourceId: paymentSource.id,
					blockchainIdentifier: decodedNewContract.blockchainIdentifier,
					newOnChainState: derivedOnChainState,
					resultHash: decodedNewContract.resultHash,
					collateralReturnLovelace: decodedNewContract.collateralReturnLovelace,
					buyerWalletAddress: decodedNewContract.buyerAddress,
					buyerWalletVkey: decodedNewContract.buyerVkey,
					buyerCooldownTime: decodedNewContract.buyerCooldownTime,
					sellerCooldownTime: decodedNewContract.sellerCooldownTime,
					outputAmounts: output.output.amount,
				});
			}
		} catch (error) {
			logger.error('[HydraConnectionManager] Failed fallback L2 datum sync', {
				hydraHeadId,
				txId,
				error,
			});
		}
	}

	private deriveOnChainStateFromDatum(
		decodedNewContract: {
			state: SmartContractState;
			resultHash: string | null;
		} | null,
	): OnChainState | null {
		if (!decodedNewContract) {
			return null;
		}

		switch (decodedNewContract.state) {
			case SmartContractState.FundsLocked:
				return decodedNewContract.resultHash ? OnChainState.ResultSubmitted : OnChainState.FundsLocked;
			case SmartContractState.ResultSubmitted:
				return OnChainState.ResultSubmitted;
			case SmartContractState.RefundRequested:
				return decodedNewContract.resultHash ? OnChainState.Disputed : OnChainState.RefundRequested;
			case SmartContractState.Disputed:
				return OnChainState.Disputed;
			default:
				return null;
		}
	}

	private async applyDatumStateToLocalRequests(params: {
		hydraHeadId: string;
		txId: string;
		paymentSourceId: string;
		blockchainIdentifier: string;
		newOnChainState: OnChainState;
		resultHash: string | null;
		collateralReturnLovelace: bigint;
		buyerWalletAddress: string;
		buyerWalletVkey: string;
		buyerCooldownTime: bigint;
		sellerCooldownTime: bigint;
		outputAmounts: Array<{ unit: string; quantity: string }>;
	}): Promise<void> {
		const {
			hydraHeadId,
			txId,
			paymentSourceId,
			blockchainIdentifier,
			newOnChainState,
			resultHash,
			collateralReturnLovelace,
			buyerWalletAddress,
			buyerWalletVkey,
			buyerCooldownTime,
			sellerCooldownTime,
			outputAmounts,
		} = params;

		await prisma.$transaction(
			async (prisma) => {
				const purchaseRequest = await prisma.purchaseRequest.findUnique({
					where: {
						blockchainIdentifier,
						paymentSourceId,
					},
					include: {
						NextAction: true,
						PaidFunds: true,
						CurrentTransaction: { include: { BlocksWallet: true } },
					},
				});

				if (purchaseRequest && purchaseRequest.NextAction.requestedAction !== PurchasingAction.None) {
					const newAction = convertNewPurchasingActionAndError(
						purchaseRequest.NextAction.requestedAction,
						newOnChainState,
					);

					await prisma.purchaseRequest.update({
						where: { id: purchaseRequest.id },
						data: {
							layer: TransactionLayer.L2,
							onChainState: newOnChainState,
							resultHash,
							buyerCoolDownTime: buyerCooldownTime,
							sellerCoolDownTime: sellerCooldownTime,
							ActionHistory: { connect: { id: purchaseRequest.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							CurrentTransaction: purchaseRequest.currentTransactionId
								? {
										update: {
											txHash: txId,
											status: TransactionStatus.Confirmed,
											layer: TransactionLayer.L2,
											HydraHead: { connect: { id: hydraHeadId } },
											previousOnChainState: purchaseRequest.onChainState,
											newOnChainState,
										},
									}
								: {
										create: {
											txHash: txId,
											status: TransactionStatus.Confirmed,
											layer: TransactionLayer.L2,
											HydraHead: { connect: { id: hydraHeadId } },
											previousOnChainState: null,
											newOnChainState,
										},
									},
						},
					});

					if (purchaseRequest.CurrentTransaction?.BlocksWallet) {
						await prisma.transaction.update({
							where: { id: purchaseRequest.currentTransactionId! },
							data: { BlocksWallet: { disconnect: true } },
						});
						await prisma.hotWallet.update({
							where: {
								id: purchaseRequest.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: { lockedAt: null },
						});
					}
				}

				const paymentRequest = await prisma.paymentRequest.findUnique({
					where: {
						blockchainIdentifier,
						paymentSourceId,
					},
					include: {
						NextAction: true,
						RequestedFunds: true,
						CurrentTransaction: { include: { BlocksWallet: true } },
					},
				});

				if (paymentRequest && paymentRequest.NextAction.requestedAction !== PaymentAction.None) {
					const amountsMatch = checkPaymentAmountsMatch(
						paymentRequest.RequestedFunds.map((amount) => ({
							unit: amount.unit,
							amount: amount.amount,
						})),
						outputAmounts.map((amount) => ({ ...amount })),
						collateralReturnLovelace,
					);
					const newState =
						newOnChainState === OnChainState.FundsLocked
							? amountsMatch
								? OnChainState.FundsLocked
								: OnChainState.FundsOrDatumInvalid
							: newOnChainState;
					const newAction = convertNewPaymentActionAndError(paymentRequest.NextAction.requestedAction, newState);

					await prisma.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							layer: TransactionLayer.L2,
							onChainState: newState,
							resultHash,
							collateralReturnLovelace,
							buyerCoolDownTime: buyerCooldownTime,
							sellerCoolDownTime: sellerCooldownTime,
							ActionHistory: { connect: { id: paymentRequest.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							BuyerWallet: {
								connectOrCreate: {
									where: {
										paymentSourceId_walletVkey_walletAddress_type: {
											paymentSourceId,
											walletVkey: buyerWalletVkey,
											walletAddress: buyerWalletAddress,
											type: WalletType.Buyer,
										},
									},
									create: {
										walletVkey: buyerWalletVkey,
										walletAddress: buyerWalletAddress,
										type: WalletType.Buyer,
										PaymentSource: { connect: { id: paymentSourceId } },
									},
								},
							},
							CurrentTransaction: paymentRequest.currentTransactionId
								? {
										update: {
											txHash: txId,
											status: TransactionStatus.Confirmed,
											layer: TransactionLayer.L2,
											HydraHead: { connect: { id: hydraHeadId } },
											previousOnChainState: paymentRequest.onChainState,
											newOnChainState: newState,
										},
									}
								: {
										create: {
											txHash: txId,
											status: TransactionStatus.Confirmed,
											layer: TransactionLayer.L2,
											HydraHead: { connect: { id: hydraHeadId } },
											previousOnChainState: null,
											newOnChainState: newState,
										},
									},
						},
					});

					if (paymentRequest.CurrentTransaction?.BlocksWallet) {
						await prisma.transaction.update({
							where: { id: paymentRequest.currentTransactionId! },
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
				}
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
				maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
			},
		);
	}
}

let _connectionManager: HydraConnectionManager | null = null;

export function getHydraConnectionManager(): HydraConnectionManager {
	if (!_connectionManager) {
		_connectionManager = new HydraConnectionManager();
	}
	return _connectionManager;
}
