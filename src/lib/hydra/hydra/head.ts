import { EventEmitter } from 'node:events';
import { UTxO } from '@meshsdk/core';
import { IHydraNode } from './node';
import { HydraProvider } from './provider';
import { HydraNodeConfig, HydraTransaction, HydraTransactionType } from './types';
import { HydraHeadStatus } from '@/generated/prisma/client';

export abstract class HydraHead<TNode extends IHydraNode = IHydraNode> extends EventEmitter {
	protected _nodeConfigs: HydraNodeConfig[];
	protected _l2HydraProviders: Record<string, HydraProvider>;
	protected _nodes: Record<string, TNode>;
	protected _connected: Record<string, boolean>;
	protected _status: HydraHeadStatus | null;

	constructor(nodeConfigs: HydraNodeConfig[]) {
		super();
		this._nodeConfigs = nodeConfigs;
		if (nodeConfigs.length === 0) {
			throw new Error('No node configs provided');
		}

		this._l2HydraProviders = {};
		this._nodes = {};
		this._connected = {};
		this._status = null;
	}

	protected abstract initializeNodes(nodeConfigs: HydraNodeConfig[]): void;

	protected abstract setupStatusChangeHandler(): void;

	get nodes() {
		return this._nodes;
	}

	get status() {
		return this._status;
	}

	get mainNodeName(): string {
		return this._nodeConfigs[0].walletId;
	}

	get mainNode(): TNode {
		return this._nodes[this.mainNodeName];
	}

	get mainNodeConnected(): boolean {
		return this._connected[this.mainNodeName] ?? false;
	}

	getHydraNode(walletId: string): TNode | undefined {
		return this._nodes[walletId];
	}

	connected(walletId: string): boolean {
		return this._connected[walletId] ?? false;
	}

	async connect(walletId: string) {
		if (this.connected(walletId)) {
			return;
		}
		try {
			const node = this.getHydraNode(walletId);
			if (!node) {
				throw new Error(`Hydra node for wallet ${walletId} is not configured`);
			}
			await node.connect();
			this._connected[walletId] = true;
		} catch (error) {
			this._connected[walletId] = false;
			throw error;
		}
	}

	abstract init(timeoutMs?: number): Promise<void>;

	abstract commit(
		utxos: UTxO[],
		blueprintTx?: HydraTransactionType | null,
		participant?: string | null,
	): Promise<HydraTransaction>;

	abstract close(): Promise<void>;

	abstract fanout(): Promise<void>;

	abstract cardanoTransaction(transaction: HydraTransaction, participant?: string | null): Promise<unknown>;

	abstract newTx(transaction: HydraTransaction, participant?: string | null): Promise<string>;

	abstract awaitTx(txHash: string, participant?: string | null): Promise<boolean>;
}
