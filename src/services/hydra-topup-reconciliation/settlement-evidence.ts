import { Network as NetworkEnum, type Network } from '@/generated/prisma/client';
import { CONFIG } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { KEY_RELEASE_MIN_CONFIRMATIONS } from '@/services/hydra-node-funding/key-release-depth';
import { classifyHydraDepositSpend, findHydraDepositReference } from './deposit-evidence';

/** What L1 did with a deposit, decided from the transaction that spent it. */
export type DepositOutcome =
	| { outcome: 'unspent' | 'unknown' }
	| { outcome: 'recovered' | 'absorbed'; settlementTxHash: string };

export async function observeHydraDepositSettlement(params: {
	network: Network;
	rpcProviderApiKey: string;
	depositTxHash: string;
	headIdentifier: string | null;
}): Promise<DepositOutcome> {
	try {
		if (params.headIdentifier === null) return { outcome: 'unknown' };
		const blockfrost = getBlockfrostInstance(params.network, params.rpcProviderApiKey);
		const depositCbor = await blockfrost.txsCbor(params.depositTxHash);
		const deposit = findHydraDepositReference({
			cborHex: depositCbor.cbor,
			txHash: params.depositTxHash,
			headIdentifier: params.headIdentifier,
			networkId: params.network === NetworkEnum.Mainnet ? 1 : 0,
		});
		if (deposit === null) return { outcome: 'unknown' };
		const utxos = await blockfrost.txsUtxos(params.depositTxHash);
		const output = utxos.outputs.find((candidate) => candidate.output_index === deposit.outputIndex);
		if (!output || output.address !== deposit.address) return { outcome: 'unknown' };
		const consumed = (output as { consumed_by_tx?: string | null }).consumed_by_tx;
		if (consumed == null) return { outcome: 'unspent' };
		const spendingCbor = await blockfrost.txsCbor(consumed);
		const outcome = classifyHydraDepositSpend({ cborHex: spendingCbor.cbor, txHash: consumed, deposit });
		if (outcome === null) return { outcome: 'unknown' };
		const finality = await lookupConfirmedChainTx({
			network: params.network,
			rpcProviderApiKey: params.rpcProviderApiKey,
			txHash: consumed,
			requiredConfirmations: Math.max(CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD, KEY_RELEASE_MIN_CONFIRMATIONS),
		});
		if (finality !== 'confirmed-valid') return { outcome: 'unknown' };
		// A rollback can change the index while we observe consumer depth. Bind
		// proof to the same exact output and current consumer after that lookup.
		const current = await blockfrost.txsUtxos(params.depositTxHash);
		const currentOutput = current.outputs.find((candidate) => candidate.output_index === deposit.outputIndex);
		if (!currentOutput || currentOutput.address !== deposit.address) return { outcome: 'unknown' };
		if ((currentOutput as { consumed_by_tx?: string | null }).consumed_by_tx !== consumed) {
			return { outcome: 'unknown' };
		}
		return { outcome, settlementTxHash: consumed };
	} catch (error) {
		// A lookup failure is not evidence of anything; leave the row alone and
		// let the next tick decide.
		logger.warn('hydra-topup-reconciliation: could not check whether a recovered deposit was spent', {
			depositTxHash: params.depositTxHash,
			error: error instanceof Error ? error.message : error,
		});
		return { outcome: 'unknown' };
	}
}
