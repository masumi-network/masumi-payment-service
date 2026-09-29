import type { GuardedWallet } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { SLOT_CONFIG_NETWORK, slotToBeginUnixTime, type BlockfrostProvider, type UTxO } from '@meshsdk/core';
import { createTxWindow } from '@/services/shared/tx-window';
import { pickBatchCollateral } from '../../../builders/batch-helpers';
import { assetValueGet, lovelaceOf, type WalletDatum } from '../../../smart-wallet/wallet';
import { fetchWalletUtxo, readWalletDatum } from '../../../smart-wallet/wallet-lifecycle';

// The validator keys lovelace as the empty policy and the empty asset name.
const LOVELACE_POLICY = '';
const LOVELACE_NAME = '';

/**
 * Lovelace a guarded wallet can lock in one transaction: its balance above the
 * reserve, capped by what the period budget still allows.
 *
 * `windowLowerMs` is the lower bound of the transaction's validity window. The
 * validator rolls the period over only when that lower bound passes the period
 * end, so using it (not the wall clock) never counts a budget the chain would
 * still charge to the old period.
 */
export function guardedSpendableLovelace(datum: WalletDatum, walletUtxo: UTxO, windowLowerMs: bigint): bigint {
	const aboveReserve = lovelaceOf(walletUtxo.output.amount) - datum.minBalanceLovelace;
	const limit = assetValueGet(datum.limit, LOVELACE_POLICY, LOVELACE_NAME) ?? 0n;
	const rolledOver = windowLowerMs >= datum.periodStart + datum.periodLength;
	const spent = rolledOver ? 0n : (assetValueGet(datum.spentInPeriod, LOVELACE_POLICY, LOVELACE_NAME) ?? 0n);
	const budgetLeft = limit - spent;
	const spendable = aboveReserve < budgetLeft ? aboveReserve : budgetLeft;
	return spendable > 0n ? spendable : 0n;
}

/**
 * The agent key pays the fee and lends the collateral, so a guarded wallet can
 * only lock while its hot wallet holds a key-locked UTxO the builder accepts as
 * collateral. Same selector the builder uses.
 */
export function agentCanFundGuardedLock(agentUtxos: UTxO[]): boolean {
	return pickBatchCollateral(agentUtxos, []) != null;
}

/**
 * The balance the packing loop may count for a guarded hot wallet, in the
 * loop's `{ unit, quantity }` shape: lovelace only, so a purchase with native
 * tokens never lands here.
 *
 * `overheadLovelace` is added back on top because the loop charges the batch
 * overhead (fee headroom + splitter) to the first request, but a guarded lock
 * pays its fee from the agent key, not from the smart wallet's budget.
 *
 * Returns no amounts, so the loop skips the wallet, when the agent cannot pay
 * the fee and collateral or the smart wallet cannot be read.
 */
export async function guardedWalletAmounts(params: {
	guarded: GuardedWallet;
	network: string;
	provider: Pick<BlockfrostProvider, 'fetchAddressUTxOs'>;
	agentUtxos: UTxO[];
	overheadLovelace: bigint;
}): Promise<Array<{ unit: string; quantity: bigint }>> {
	const { guarded, network } = params;
	if (network !== 'preprod' && network !== 'mainnet') return [];
	if (!agentCanFundGuardedLock(params.agentUtxos)) {
		logger.warn('guarded hot wallet cannot fund the fee and collateral; skipping it', {
			hotWalletId: guarded.hotWalletId,
		});
		return [];
	}
	try {
		const walletUtxo = await fetchWalletUtxo(
			params.provider,
			{ address: guarded.scriptAddress, policyId: guarded.policyId },
			guarded.stateTokenName,
		);
		const window = createTxWindow(network);
		const windowLowerMs = BigInt(slotToBeginUnixTime(window.invalidBefore, SLOT_CONFIG_NETWORK[network]));
		const spendable = guardedSpendableLovelace(readWalletDatum(walletUtxo), walletUtxo, windowLowerMs);
		return [{ unit: '', quantity: spendable + params.overheadLovelace }];
	} catch (error) {
		logger.warn('guarded smart wallet could not be read; skipping it', {
			hotWalletId: guarded.hotWalletId,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}
