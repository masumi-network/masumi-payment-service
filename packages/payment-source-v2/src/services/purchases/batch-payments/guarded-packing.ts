import type { GuardedWallet } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
// V2 mesh line: the smart wallet read must not go through the root (V1) provider.
import { BlockfrostProvider, SLOT_CONFIG_NETWORK, slotToBeginUnixTime, type UTxO } from '@meshsdk/core';
import { createTxWindow } from '@/services/shared/tx-window';
import { pickBatchCollateral } from '../../../builders/batch-helpers';
import { assetValueGet, lovelaceOf, type WalletDatum } from '../../../smart-wallet/wallet';
import { fetchWalletUtxo, readWalletDatum } from '../../../smart-wallet/wallet-lifecycle';
import { cosignConfigOrNull } from './cosign-config';

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
	const budgetLeft = guardedBudgetLeftLovelace(datum, windowLowerMs);
	const spendable = aboveReserve < budgetLeft ? aboveReserve : budgetLeft;
	return spendable > 0n ? spendable : 0n;
}

/** What the period budget still allows, after the validator's period rollover. */
export function guardedBudgetLeftLovelace(datum: WalletDatum, windowLowerMs: bigint): bigint {
	const limit = assetValueGet(datum.limit, LOVELACE_POLICY, LOVELACE_NAME) ?? 0n;
	const rolledOver = windowLowerMs >= datum.periodStart + datum.periodLength;
	const spent = rolledOver ? 0n : (assetValueGet(datum.spentInPeriod, LOVELACE_POLICY, LOVELACE_NAME) ?? 0n);
	return limit - spent;
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
 * Returns null when the wallet cannot take a purchase this tick for a reason
 * that may clear: co-signing is not configured, the agent cannot pay the fee
 * and collateral, the smart wallet cannot be read, or the period budget is
 * spent. The caller must not count such a wallet as evaluated, or it parks
 * purchases as InsufficientFunds for a state that fixes itself.
 */
export async function guardedWalletAmounts(params: {
	guarded: GuardedWallet;
	network: string;
	rpcApiKey: string;
	agentUtxos: UTxO[];
	overheadLovelace: bigint;
}): Promise<Array<{ unit: string; quantity: bigint }> | null> {
	const { guarded, network } = params;
	if (network !== 'preprod' && network !== 'mainnet') return null;
	if (cosignConfigOrNull() == null) {
		logger.warn('guarded hot wallet skipped: Exchain co-signing is not configured', {
			hotWalletId: guarded.hotWalletId,
		});
		return null;
	}
	if (!agentCanFundGuardedLock(params.agentUtxos)) {
		logger.warn('guarded hot wallet cannot fund the fee and collateral; skipping it', {
			hotWalletId: guarded.hotWalletId,
		});
		return null;
	}
	try {
		const walletUtxo = await fetchWalletUtxo(
			new BlockfrostProvider(params.rpcApiKey),
			{ address: guarded.scriptAddress, policyId: guarded.policyId },
			guarded.stateTokenName,
		);
		const datum = readWalletDatum(walletUtxo);
		const window = createTxWindow(network);
		const windowLowerMs = BigInt(slotToBeginUnixTime(window.invalidBefore, SLOT_CONFIG_NETWORK[network]));
		if (guardedBudgetLeftLovelace(datum, windowLowerMs) <= 0n) {
			logger.info('guarded hot wallet skipped: period budget spent', { hotWalletId: guarded.hotWalletId });
			return null;
		}
		const spendable = guardedSpendableLovelace(datum, walletUtxo, windowLowerMs);
		return [{ unit: '', quantity: spendable + params.overheadLovelace }];
	} catch (error) {
		logger.warn('guarded smart wallet could not be read; skipping it', {
			hotWalletId: guarded.hotWalletId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
