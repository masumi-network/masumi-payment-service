import { Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { TransactionMetadata } from '@/services/transactions/tx-sync/blockchain';

export type UpdateTransactionInput = {
	blockTime: number;
	tx: { tx_hash: string };
	block: { confirmations: number };
	metadata: TransactionMetadata;
	utxos: {
		hash: string;
		inputs: Array<{
			address: string;
			amount: Array<{ unit: string; quantity: string }>;
			tx_hash: string;
			output_index: number;
			data_hash: string | null;
			inline_datum: string | null;
			reference_script_hash: string | null;
			collateral: boolean;
			reference?: boolean;
		}>;
		outputs: Array<{
			address: string;
			amount: Array<{ unit: string; quantity: string }>;
			output_index: number;
			data_hash: string | null;
			inline_datum: string | null;
			collateral: boolean;
			reference_script_hash: string | null;
			consumed_by_tx?: string | null;
		}>;
	};
	transaction: Transaction;
};
