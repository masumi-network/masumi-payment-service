import type { GetWalletGuardedHydraResponses } from '@/lib/api/generated';
import type { HydraHead } from '@/lib/hooks/hydra/types';

export type GuardedHydraState = GetWalletGuardedHydraResponses[200]['data'];
export type GuardedHydraTransfer = GuardedHydraState['transfers'][number];

/** Open heads where this hot wallet is the local participant: the only ones a deposit can enter. */
export function openHeadsForWallet(heads: HydraHead[], hotWalletId: string): HydraHead[] {
  return heads.filter(
    (head) => head.status === 'Open' && head.LocalParticipant?.walletId === hotWalletId,
  );
}

/** A move the service still waits on. The status read settles it, so keep polling. */
export function hasMoveInFlight(state: GuardedHydraState | null): boolean {
  if (state == null) return false;
  return (
    state.location === 'Unknown' ||
    state.transfers.some(
      (transfer) => transfer.status === 'Prepared' || transfer.status === 'Submitted',
    )
  );
}

/** A submitted deposit the head did not take in, past the moment it can go back to L1. */
export function isRecoverable(transfer: GuardedHydraTransfer, now: Date): boolean {
  return (
    transfer.direction === 'Deposit' &&
    transfer.status === 'Submitted' &&
    transfer.recoverableAt != null &&
    new Date(transfer.recoverableAt).getTime() <= now.getTime()
  );
}

/** Share of the period limit already spent, 0 to 100. Lovelace strings, so no float drift. */
export function periodUsePercent(spentLovelace: string, limitLovelace: string): number {
  const limit = BigInt(limitLovelace);
  if (limit <= BigInt(0)) return 0;
  const percent = Number((BigInt(spentLovelace) * BigInt(100)) / limit);
  return Math.min(percent, 100);
}
