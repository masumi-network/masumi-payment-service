import type { UTxO } from '@meshsdk/core';
import { HydraHead } from './head';
import { HydraNode } from './node';
import { HydraTransaction, HydraTransactionType, HydraHeadEvent, HydraNodeEvent, HydraNodeConfig } from './types';
import { HydraHeadStatus } from '@/generated/prisma/client';

export class CustomHydraHead extends HydraHead<HydraNode> {
	constructor(nodeConfigs: HydraNodeConfig[]) {
		super(nodeConfigs);

		this.initializeNodes(nodeConfigs);
		this.setupStatusChangeHandler();
	}

	protected initializeNodes(nodeConfigs: HydraNodeConfig[]): void {
		for (const nodeConfig of nodeConfigs) {
			const node = new HydraNode({
				httpUrl: nodeConfig.httpUrl,
			});
			this._nodes[nodeConfig.walletId] = node;
			this._connected[nodeConfig.walletId] = false;
		}
	}

	protected setupStatusChangeHandler(): void {
		this.mainNode.on(HydraNodeEvent.StatusChange, (status: HydraHeadStatus) => {
			this._status = status;
			this.emit(HydraHeadEvent.StatusChange, this._status);
		});
	}

	async init(): Promise<void> {
		if (!this.mainNodeConnected) {
			throw new Error('Main node not connected');
		}
		await this.mainNode.init();
	}

	async commit(
		utxos: UTxO[],
		blueprintTx?: HydraTransactionType | null,
		participant?: string | null,
	): Promise<HydraTransaction> {
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
		await this.mainNode.close();
	}

	async fanout(): Promise<void> {
		await this.mainNode.fanout();
	}

	async cardanoTransaction(transaction: HydraTransaction, participant?: string | null): Promise<unknown> {
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
