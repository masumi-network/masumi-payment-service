import type { WalletFundTransfer } from '@/lib/api/generated';

type Status = WalletFundTransfer['status'];

// Matches the status-pill vocabulary the Swap section uses in the same dialog:
// a colored dot plus label on a faint surface, so the two histories read alike.
const META: Record<Status, { label: string; dot: string; text: string; pulse?: boolean }> = {
  Pending: { label: 'Pending', dot: 'bg-yellow-500', text: 'text-yellow-500', pulse: true },
  Confirmed: { label: 'Confirmed', dot: 'bg-green-500', text: 'text-green-500' },
  FailedViaTimeout: { label: 'Timed out', dot: 'bg-red-500', text: 'text-destructive' },
  FailedViaManualReset: { label: 'Failed', dot: 'bg-red-500', text: 'text-destructive' },
  RolledBack: { label: 'Rolled back', dot: 'bg-red-500', text: 'text-destructive' },
};

export function FundTransferStatusBadge({ status }: { status: Status }) {
  const meta = META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-background/60 px-2 py-0.5 text-[11px] font-medium ${meta.text}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${meta.pulse ? 'animate-pulse' : ''}`}
      />
      {meta.label}
    </span>
  );
}
