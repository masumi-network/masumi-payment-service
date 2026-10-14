import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import {
	describeWalletUtxo,
	inspectGuardedWallet,
	type GuardedWalletState,
} from '@masumi/payment-source-v2/smart-wallet/guarded-wallet';
import { DEPOSIT_L1_GRACE_MS, WITHDRAW_SETTLE_TIMEOUT_MS } from '@masumi/payment-source-v2/smart-wallet/hydra-transfer';
import { assetsView } from '../assets-view';
import { isHydraFanoutTx } from './hydra-tx-name';
import { findGuardedWalletInHead } from './location';
import { loadGuardedHotWallet, transferView } from './transfers';

type Scope = Parameters<typeof loadGuardedHotWallet>[1];

const RECENT_TRANSFERS = 10;

const WITHDRAW_NOT_TAKEN = 'The head still holds the wallet; it did not take the withdraw';
const DEPOSIT_NOT_ABSORBED = 'The head did not absorb the deposit; the wallet is on L1';
const DEPOSIT_ELSEWHERE = 'The wallet went into another head; this deposit can never apply';
const WITHDRAW_FANNED_OUT = 'The head closed and fanned the wallet out; it did not take the withdraw';

function stateView(state: GuardedWalletState) {
	return {
		lovelace: state.lovelace.toString(),
		periodLimitLovelace: state.periodLimitLovelace.toString(),
		spentInPeriodLovelace: state.spentInPeriodLovelace.toString(),
		periodStart: new Date(Number(state.periodStartMs)),
		periodLengthMs: state.periodLengthMs.toString(),
		minBalanceLovelace: state.minBalanceLovelace.toString(),
		assets: assetsView(state),
	};
}

/**
 * Where the guarded wallet is now (a head, L1, or neither while it moves) and its
 * recent moves. Reading the location also settles those moves: a deposit is
 * Confirmed once the head holds the state token, a withdraw once L1 does, and a
 * Prepared move the owner never signed in time becomes Expired.
 */
export async function getGuardedHydraStatus(hotWalletId: string, scope: Scope) {
	const { hotWallet, guarded, params } = await loadGuardedHotWallet(hotWalletId, scope);
	const inHead = await findGuardedWalletInHead(hotWallet.id, guarded);

	let l1State: GuardedWalletState | null = null;
	let l1Error: string | null = null;
	if (inHead == null) {
		try {
			l1State = await inspectGuardedWallet(params, hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey);
		} catch (error) {
			l1Error = error instanceof Error ? error.message : String(error);
		}
	}

	const now = new Date();
	await prisma.guardedHydraTransfer.updateMany({
		where: { guardedWalletId: guarded.id, status: GuardedHydraTransferStatus.Prepared, signBefore: { lte: now } },
		data: { status: GuardedHydraTransferStatus.Expired },
	});
	// Only a Submitted move can still take effect: a clear rejection or a failure
	// this read wrote is final. Only the newest such move settles.
	const unsettled = { status: GuardedHydraTransferStatus.Submitted };
	// A move older than the last confirmed one never took effect: the wallet moved on without it.
	const lastConfirmed = await prisma.guardedHydraTransfer.findFirst({
		where: { guardedWalletId: guarded.id, status: GuardedHydraTransferStatus.Confirmed },
		orderBy: { createdAt: 'desc' },
		select: { createdAt: true },
	});
	const confirmNewest = async (direction: GuardedHydraTransferDirection, match: { hydraHeadId?: string } = {}) => {
		const newest = await prisma.guardedHydraTransfer.findFirst({
			where: {
				guardedWalletId: guarded.id,
				direction,
				hydraHeadId: match.hydraHeadId,
				createdAt: lastConfirmed != null ? { gt: lastConfirmed.createdAt } : undefined,
				...unsettled,
			},
			orderBy: { createdAt: 'desc' },
			select: { id: true },
		});
		if (newest == null) return;
		await prisma.guardedHydraTransfer.update({
			where: { id: newest.id },
			data: { status: GuardedHydraTransferStatus.Confirmed, confirmedAt: now, failureReason: null },
		});
	};
	if (inHead != null) {
		const inHeadRef = `${inHead.walletUtxo.input.txHash}#${inHead.walletUtxo.input.outputIndex}`;
		// Without the head state the wallet UTxO may be an approved deposit that never
		// finalizes: neither this deposit nor one to another head is settled from it.
		if (inHead.isCommitStateKnown) {
			// Only a deposit puts the wallet into a head. The ref is not matched: an in-head
			// purchase may already have spent the deposited UTxO.
			await confirmNewest(GuardedHydraTransferDirection.Deposit, { hydraHeadId: inHead.hydraHeadId });
			// One state token: a deposit to any other head can never apply.
			await prisma.guardedHydraTransfer.updateMany({
				where: {
					guardedWalletId: guarded.id,
					direction: GuardedHydraTransferDirection.Deposit,
					status: GuardedHydraTransferStatus.Submitted,
					hydraHeadId: { not: inHead.hydraHeadId },
				},
				data: { status: GuardedHydraTransferStatus.Failed, failureReason: DEPOSIT_ELSEWHERE },
			});
		}
		// Still in the head: a withdraw of another UTxO can never apply, and one of
		// this UTxO that the head has not taken out by now was rejected.
		await prisma.guardedHydraTransfer.updateMany({
			where: {
				guardedWalletId: guarded.id,
				direction: GuardedHydraTransferDirection.Withdraw,
				status: GuardedHydraTransferStatus.Submitted,
				OR: [
					{ walletUtxoRef: { not: inHeadRef } },
					{ submittedAt: { lte: new Date(now.getTime() - WITHDRAW_SETTLE_TIMEOUT_MS) } },
				],
			},
			data: {
				status: GuardedHydraTransferStatus.Failed,
				failureReason: WITHDRAW_NOT_TAKEN,
			},
		});
	} else if (l1State != null) {
		// A fanout also brings the wallet to L1. Only a withdraw that the head took
		// (a decrement or a later L1 tx) confirms; after a fanout, an open withdraw failed.
		let fannedOut: boolean | null = null;
		try {
			fannedOut = await isHydraFanoutTx(
				hotWallet.PaymentSource.network,
				hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
				l1State.utxoTxHash,
			);
		} catch (error) {
			// Unknown origin: leave open withdraws as they are; the next read settles them.
			l1Error = error instanceof Error ? error.message : String(error);
		}
		if (fannedOut === false) {
			await confirmNewest(GuardedHydraTransferDirection.Withdraw);
		} else if (fannedOut === true) {
			await prisma.guardedHydraTransfer.updateMany({
				where: { guardedWalletId: guarded.id, direction: GuardedHydraTransferDirection.Withdraw, ...unsettled },
				data: { status: GuardedHydraTransferStatus.Failed, failureReason: WITHDRAW_FANNED_OUT },
			});
		}
		// On L1 again after the recovery deadline, or after the deposit tx expired
		// unseen: either way the head never took the deposit in.
		await prisma.guardedHydraTransfer.updateMany({
			where: {
				guardedWalletId: guarded.id,
				direction: GuardedHydraTransferDirection.Deposit,
				status: GuardedHydraTransferStatus.Submitted,
				OR: [{ recoverableAt: { lte: now } }, { signBefore: { lte: new Date(now.getTime() - DEPOSIT_L1_GRACE_MS) } }],
			},
			data: {
				status: GuardedHydraTransferStatus.Failed,
				failureReason: DEPOSIT_NOT_ABSORBED,
			},
		});
	}

	const transfers = await prisma.guardedHydraTransfer.findMany({
		where: { guardedWalletId: guarded.id },
		orderBy: { createdAt: 'desc' },
		take: RECENT_TRANSFERS,
	});
	const state =
		inHead != null
			? describeWalletUtxo({ address: guarded.scriptAddress, policyId: guarded.policyId }, inHead.walletUtxo)
			: l1State;
	return {
		location: inHead != null ? ('L2' as const) : l1State != null ? ('L1' as const) : ('Unknown' as const),
		hydraHeadId: inHead?.hydraHeadId ?? null,
		walletUtxoRef: inHead != null ? `${inHead.walletUtxo.input.txHash}#${inHead.walletUtxo.input.outputIndex}` : null,
		state: state != null ? stateView(state) : null,
		l1Error,
		transfers: transfers.map(transferView),
	};
}
