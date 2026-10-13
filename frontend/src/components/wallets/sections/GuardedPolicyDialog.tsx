import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { PolicyRow } from '@/components/wallets/guarded-policy-form';

/**
 * "Limits and deposit": per-asset limits and value moved in from the owner.
 * Renders and forwards only; useGuardedPolicy holds the state.
 */
export function GuardedPolicyDialog({
  rows,
  isBusy,
  blockedReason,
  onRowsChange,
  onSubmit,
  onClose,
}: {
  rows: PolicyRow[] | null;
  isBusy: boolean;
  blockedReason: string | null;
  onRowsChange: (rows: PolicyRow[]) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const setField = (index: number, field: 'limit' | 'deposit', value: string) =>
    rows != null &&
    onRowsChange(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  return (
    <Dialog open={rows != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Limits and deposit</DialogTitle>
          <DialogDescription>
            Limits are per period. An asset without a limit cannot leave the wallet. The owner
            wallet pays the deposit and the fee, and signs.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 text-xs text-muted-foreground">
            <span>Asset</span>
            <span>Limit per period</span>
            <span>Deposit now</span>
          </div>
          {rows?.map((row, index) => (
            <div key={row.unit} className="grid grid-cols-[1fr_1fr_1fr] items-center gap-2">
              <span className="truncate text-sm" title={row.unit}>
                {row.label}
                {row.decimals === 0 && (
                  <span className="text-xs text-muted-foreground"> (raw)</span>
                )}
              </span>
              <Input
                value={row.limit}
                onChange={(e) => setField(index, 'limit', e.target.value)}
                placeholder={row.isRequired || row.isHeld ? 'Required' : 'Not listed'}
                aria-label={`${row.label} limit`}
                className="h-8"
              />
              <Input
                value={row.deposit}
                onChange={(e) => setField(index, 'deposit', e.target.value)}
                placeholder="0"
                aria-label={`${row.label} deposit`}
                className="h-8"
              />
            </div>
          ))}
          {blockedReason != null && (
            <div className="text-xs text-muted-foreground">{blockedReason}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isBusy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={isBusy || blockedReason != null}>
            {isBusy ? 'Signing…' : 'Check and sign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
