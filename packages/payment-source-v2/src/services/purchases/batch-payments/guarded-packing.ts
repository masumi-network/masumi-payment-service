import type { GuardedWallet } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
// V2 mesh line: the smart wallet read must not go through the root (V1) provider.
import { BlockfrostProvider, SLOT_CONFIG_NETWORK, slotToBeginUnixTime, type UTxO } from '@meshsdk/core';
import { createTxWindow } from '@/services/shared/tx-window';
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import { pickBatchCollateral } from '../../../builders/batch-helpers';
import { coinsPerUtxoSizeOf, guardedContinuingMinLovelace } from '../../../smart-wallet/guarded-lock-builder';
import { assetValueGet, lovelaceOf, type WalletDatum } from '../../../smart-wallet/wallet';
import { fetchWalletUtxo, readWalletDatum } from '../../../smart-wallet/wallet-lifecycle';
import { cosignConfigOrNull } from './cosign-config';

// The next datum can be larger than the current one: the lovelace spentInPeriod and
// periodStart integers widen by up to 8 CBOR bytes each (16 in all). 32 leaves headroom.
const NEXT_DATUM_GROWTH_BYTES = 32;
// The validator keys lovelace as the empty policy and the empty asset name.
const LOVELACE_POLICY = '';
const LOVELACE_NAME = '';

/**
 * Lovelace a guarded wallet can lock in one transaction: its balance above the
 * reserve, capped by what the period budget still allows. The reserve is the
 * larger of the datum's minimum balance and the continuing output's min-UTxO.
 *
 * `windowLowerMs` is the lower bound of the transaction's validity window. The
 * validator rolls the period over only when that lower bound passes the period
 * end, so using it (not the wall clock) never counts a budget the chain would
 * still charge to the old period.
 */
export function guardedSpendableLovelace(
	datum: WalletDatum,
	walletUtxo: UTxO,
	windowLowerMs: bigint,
	continuingMinLovelace: bigint,
): bigint {
	const aboveReserve = guardedAboveReserveLovelace(datum, walletUtxo, continuingMinLovelace);
	const budgetLeft = guardedBudgetLeftLovelace(datum, windowLowerMs);
	const spendable = aboveReserve < budgetLeft ? aboveReserve : budgetLeft;
	return spendable > 0n ? spendable : 0n;
}

function guardedAboveReserveLovelace(datum: WalletDatum, walletUtxo: UTxO, continuingMinLovelace: bigint): bigint {
	const reserve = datum.minBalanceLovelace > continuingMinLovelace ? datum.minBalanceLovelace : continuingMinLovelace;
	return lovelaceOf(walletUtxo.output.amount) - reserve;
}

/**
 * True when the period budget, not the balance, is what holds the wallet back,
 * and the budget has been partly used. That clears at the period end, so a
 * purchase that does not fit now must not be parked as InsufficientFunds.
 */
export function isGuardedBudgetBound(
	datum: WalletDatum,
	walletUtxo: UTxO,
	windowLowerMs: bigint,
	continuingMinLovelace: bigint,
): boolean {
	const limit = assetValueGet(datum.limit, LOVELACE_POLICY, LOVELACE_NAME) ?? 0n;
	const budgetLeft = guardedBudgetLeftLovelace(datum, windowLowerMs);
	return budgetLeft < limit && budgetLeft < guardedAboveReserveLovelace(datum, walletUtxo, continuingMinLovelace);
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
 * `evaluated` is false only for states that clear on their own: the smart
 * wallet could not be read, or a partly used period budget holds it back. The
 * caller must not count such a wallet as evaluated, or it parks purchases as
 * InsufficientFunds. States that need an operator (no co-sign config, an agent
 * that cannot pay the fee, a frozen limit) count as evaluated, so one such
 * wallet cannot stop InsufficientFunds parking for the whole source.
 */
export async function guardedWalletAmounts(params: {
	guarded: GuardedWallet;
	network: string;
	rpcApiKey: string;
	agentUtxos: UTxO[];
	overheadLovelace: bigint;
}): Promise<{ amounts: Array<{ unit: string; quantity: bigint }>; evaluated: boolean }> {
	const { guarded, network } = params;
	const unusable = { amounts: [], evaluated: true };
	if (network !== 'preprod' && network !== 'mainnet') return unusable;
	if (cosignConfigOrNull() == null) {
		logger.warn('guarded hot wallet skipped: Exchain co-signing is not configured', {
			hotWalletId: guarded.hotWalletId,
		});
		return unusable;
	}
	if (!agentCanFundGuardedLock(params.agentUtxos)) {
		logger.warn('guarded hot wallet cannot fund the fee and collateral; skipping it', {
			hotWalletId: guarded.hotWalletId,
		});
		return unusable;
	}
	try {
		const provider = new BlockfrostProvider(params.rpcApiKey);
		const walletUtxo = await fetchWalletUtxo(
			provider,
			{ address: guarded.scriptAddress, policyId: guarded.policyId },
			guarded.stateTokenName,
		);
		const datum = readWalletDatum(walletUtxo);
		const protocolParameters =
			getCachedChainProtocolParameters(params.rpcApiKey) ?? (await provider.fetchProtocolParameters());
		const continuingMin = guardedContinuingMinLovelace({
			address: guarded.scriptAddress,
			datum,
			amount: walletUtxo.output.amount,
			coinsPerUtxoSize: coinsPerUtxoSizeOf(protocolParameters),
			extraBytes: NEXT_DATUM_GROWTH_BYTES,
		});
		const window = createTxWindow(network);
		const windowLowerMs = BigInt(slotToBeginUnixTime(window.invalidBefore, SLOT_CONFIG_NETWORK[network]));
		const spendable = guardedSpendableLovelace(datum, walletUtxo, windowLowerMs, continuingMin);
		return {
			amounts: [{ unit: '', quantity: spendable + params.overheadLovelace }],
			evaluated: !isGuardedBudgetBound(datum, walletUtxo, windowLowerMs, continuingMin),
		};
	} catch (error) {
		logger.warn('guarded smart wallet could not be read; skipping it', {
			hotWalletId: guarded.hotWalletId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { amounts: [], evaluated: false };
	}
}
