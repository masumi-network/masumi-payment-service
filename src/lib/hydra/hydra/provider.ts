/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type {
	AccountInfo,
	Asset,
	AssetMetadata,
	BlockInfo,
	GovernanceProposalInfo,
	IFetcherOptions,
	Protocol,
	TransactionInfo,
	UTxO,
} from '@meshsdk/core';
import { POLICY_ID_LENGTH } from '@meshsdk/core';
import type { IFetcher, ISubmitter } from '@meshsdk/core';

import type { IHydraNode } from './node';
import { HydraTransactionType } from './types';
import type { HydraTransaction } from './types';

export class HydraProvider implements IFetcher, ISubmitter {
	private readonly _node: IHydraNode;

	constructor({ node }: { node: IHydraNode }) {
		this._node = node;

		void this._node.connect();
	}

	async fetchAddressUTxOs(address: string, asset?: string): Promise<UTxO[]> {
		const utxos = await this.fetchUTxOs();
		const utxo = utxos.filter((utxo) => utxo.output.address === address);
		if (asset) {
			return utxo.filter((utxo) => utxo.output.amount.some((a) => a.unit === asset));
		}
		return utxo;
	}

	async fetchProtocolParameters(): Promise<Protocol> {
		return await this._node.fetchProtocolParameters();
	}

	async fetchUTxOs(hash?: string, index?: number): Promise<UTxO[]> {
		const snapshotUTxOs = await this._node.snapshotUTxO();
		const results = hash ? snapshotUTxOs.filter((utxo) => utxo.input.txHash === hash) : snapshotUTxOs;

		return index ? results.filter((utxo) => utxo.input.outputIndex === index) : results;
	}

	async fetchAssetAddresses(asset: string): Promise<Array<{ address: string; quantity: string }>> {
		const utxos = await this.fetchUTxOs();
		const addressesWithQuantity: Array<{ address: string; quantity: string }> = [];
		for (const utxo of utxos) {
			const found = utxo.output.amount.find((a) => a.unit === asset);
			if (found) {
				addressesWithQuantity.push({
					address: utxo.output.address,
					quantity: found.quantity,
				});
			}
		}
		if (addressesWithQuantity.length === 0 || undefined) {
			throw new Error(`No address found holding asset: ${asset}`);
		}
		return addressesWithQuantity;
	}

	async fetchCollectionAssets(policyId: string): Promise<{ assets: Asset[] }> {
		if (policyId.length !== POLICY_ID_LENGTH) {
			throw new Error('Invalid policyId length: must be a 56-character hexadecimal string');
		}

		const utxos = await this.fetchUTxOs();
		const filteredUtxos = utxos.filter((utxo) =>
			utxo.output.amount.some((a) => a.unit.slice(0, POLICY_ID_LENGTH) === policyId),
		);
		if (filteredUtxos.length === 0 || undefined) {
			throw new Error(`No assets found in the head snapshot: ${policyId}`);
		}
		return {
			assets: filteredUtxos.flatMap((utxo) =>
				utxo.output.amount
					.filter((a) => a.unit.length > policyId.length && a.unit.startsWith(policyId))
					.map((a) => ({
						unit: a.unit,
						quantity: a.quantity,
					})),
			),
		};
	}

	async submitTx(cborHex: string): Promise<string> {
		const transaction: HydraTransaction = {
			type: HydraTransactionType.TxConwayEra,
			description: '',
			cborHex,
		};
		const txHash = await this._node.newTx(transaction);
		return txHash;
	}

	async get(url: string): Promise<any> {
		const response = await this._node.get(url);
		return response;
	}

	async fetchAccountInfo(_address?: string): Promise<AccountInfo> {
		throw new Error('Not supported in Hydra L2.');
	}

	async fetchAddressTxs(_address?: string, _option?: IFetcherOptions): Promise<TransactionInfo[]> {
		throw new Error('Not supported in Hydra L2.');
	}

	async fetchAssetMetadata(_asset?: string): Promise<AssetMetadata> {
		throw new Error('Not supported in Hydra L2.');
	}

	async fetchBlockInfo(_hash?: string): Promise<BlockInfo> {
		throw new Error('Not supported in Hydra L2.');
	}

	async fetchGovernanceProposal(_txHash?: string, _certIndex?: number): Promise<GovernanceProposalInfo> {
		throw new Error('Not supported in Hydra L2.');
	}

	async fetchTxInfo(_hash: string): Promise<TransactionInfo> {
		throw new Error('Not supported in Hydra L2.');
	}
}
