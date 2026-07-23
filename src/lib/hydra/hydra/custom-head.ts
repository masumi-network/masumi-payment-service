import type { UTxO } from '@meshsdk/core';
import { HydraHead } from './head';
import { HydraNode } from './node';
import {
	HydraTransaction,
	HydraTransactionType,
	HydraHeadEvent,
	HydraNodeEvent,
	HydraNodeConfig,
	StatusChangeData,
} from './types';
import { HydraTransportError } from './errors';

export class CustomHydraHead extends HydraHead<HydraNode> {
	private readonly _isMutationAllowed: () => boolean;

	constructor(nodeConfigs: HydraNodeConfig[], options: { isMutationAllowed?: () => boolean } = {}) {
		super(nodeConfigs);
		this._isMutationAllowed = options.isMutationAllowed ?? (() => true);

		this.initializeNodes(nodeConfigs);
		this.setupStatusChangeHandler();
	}

	private assertMutationAllowed(): void {
		if (!this._isMutationAllowed()) {
			throw new HydraTransportError('Hydra head is no longer admitted for mutating commands');
		}
	}

	protected initializeNodes(nodeConfigs: HydraNodeConfig[]): void {
		for (const nodeConfig of nodeConfigs) {
			const node = new HydraNode({
				httpUrl: nodeConfig.httpUrl,
				wsUrl: nodeConfig.wsUrl,
				expectedHeadId: nodeConfig.expectedHeadId,
				reconciledHistoryCursor: nodeConfig.reconciledHistoryCursor,
				snapshotVerificationKeys: nodeConfig.snapshotVerificationKeys,
				expectedNodeVerificationKey: nodeConfig.expectedNodeVerificationKey,
				trustLocalNodeSnapshotMetadata: nodeConfig.trustLocalNodeSnapshotMetadata,
			});
			this._nodes[nodeConfig.walletId] = node;
			this._connected[nodeConfig.walletId] = false;
		}
	}

	protected setupStatusChangeHandler(): void {
		this.mainNode.on(HydraNodeEvent.StatusChange, (data: StatusChangeData) => {
			this._status = data.status;
			this.emit(HydraHeadEvent.StatusChange, data);
		});
	}

	async init(timeoutMs?: number): Promise<void> {
		this.assertMutationAllowed();
		if (!this.mainNodeConnected) {
			throw new Error('Main node not connected');
		}
		await this.mainNode.init(timeoutMs);
	}

	async commit(
		utxos: UTxO[],
		blueprintTx?: HydraTransactionType | null,
		participant?: string | null,
	): Promise<HydraTransaction> {
		this.assertMutationAllowed();
		if (!participant) {
			participant = this.mainNodeName;
		}

		const node = this.getHydraNode(participant);
		if (!node) {
			throw new Error(`Participant ${participant} not found in node`);
		}

		return await node.commit(utxos, blueprintTx as string | undefined);
	}

	async close(): Promise<void> {
		this.assertMutationAllowed();
		await this.mainNode.close();
	}

	async fanout(): Promise<void> {
		this.assertMutationAllowed();
		await this.mainNode.fanout();
	}

	async cardanoTransaction(transaction: HydraTransaction, participant?: string | null): Promise<unknown> {
		this.assertMutationAllowed();
		if (!participant) {
			participant = this.mainNodeName;
		}

		const node = this.getHydraNode(participant);
		if (!node) {
			throw new Error(`Participant ${participant} not found`);
		}
		return await node.cardanoTransaction(transaction);
	}

	async newTx(transaction: HydraTransaction, participant?: string | null): Promise<string> {
		this.assertMutationAllowed();
		if (!participant) {
			participant = this.mainNodeName;
		}

		const node = this.getHydraNode(participant);
		if (!node) {
			throw new Error(`Participant ${participant} not found`);
		}
		return await node.newTx(transaction);
	}

	async awaitTx(txHash: string, participant?: string | null): Promise<boolean> {
		if (!participant) {
			participant = this.mainNodeName;
		}

		const node = this.getHydraNode(participant);
		if (!node) {
			throw new Error(`Participant ${participant} not found`);
		}
		return await node.awaitTx(txHash);
	}
}
