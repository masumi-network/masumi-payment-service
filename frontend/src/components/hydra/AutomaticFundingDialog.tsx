import { Loader2 } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useHydraAutomaticFunding } from '@/lib/hooks/useHydraAutomaticFunding';
import { fundingLovelaceToAda } from './automatic-funding';

export function AutomaticFundingDialog({
  participantId,
  onClose,
}: {
  participantId: string;
  onClose: () => void;
}) {
  const model = useHydraAutomaticFunding(participantId);
  const { funding, settings, isSaving, limitError } = model;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogContent size="sm" elevatedChildStack hideClose={isSaving}>
        <DialogHeader>
          <DialogTitle>Automatic funding</DialogTitle>
          <DialogDescription>
            Control automatic refills for this head process. Funding is unlimited unless you set a
            limit.
          </DialogDescription>
        </DialogHeader>
        {model.isLoading ? (
          <p role="status">Loading funding settings...</p>
        ) : model.error ? (
          <div className="space-y-2">
            <p role="alert">Could not load funding settings.</p>
            <Button type="button" variant="outline" onClick={() => void model.retry()}>
              Try again
            </Button>
          </div>
        ) : funding ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="auto-fund">Enable automatic funding</Label>
              <Switch
                id="auto-fund"
                checked={settings.autoFund}
                onCheckedChange={(autoFund) => model.change({ autoFund })}
                disabled={isSaving}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="funding-limit-enabled">Set a funding limit</Label>
              <Switch
                id="funding-limit-enabled"
                checked={settings.hasLimit}
                onCheckedChange={(hasLimit) => model.change({ hasLimit })}
                disabled={isSaving}
              />
            </div>
            {settings.hasLimit ? (
              <div className="space-y-2">
                <Label htmlFor="funding-limit">Lifetime funding limit (ADA)</Label>
                <Input
                  id="funding-limit"
                  inputMode="decimal"
                  value={settings.limitAda}
                  onChange={(event) => model.change({ limitAda: event.target.value })}
                  disabled={isSaving}
                  aria-invalid={limitError !== null}
                  aria-describedby="funding-limit-help funding-limit-error"
                />
                <p id="funding-limit-error" role="alert" className="text-xs text-destructive">
                  {limitError}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Automatic funding has no limit.</p>
            )}
            <p id="funding-limit-help" className="text-xs text-muted-foreground">
              The limit counts all past and queued funding to this address from service wallets,
              including manual funding. Failed transfers do not count. A full refill is skipped if
              it would exceed the limit. Zero stops automatic refills. Manual top ups remain
              available.
            </p>
            <dl className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
              <dt>Queued or sent</dt>
              <dd className="text-right">{fundingLovelaceToAda(funding.fundedLovelace)} ADA</dd>
              <dt>Remaining saved allowance</dt>
              <dd className="text-right">
                {funding.remainingFundingLovelace === null
                  ? 'Unlimited'
                  : `${fundingLovelaceToAda(funding.remainingFundingLovelace)} ADA`}
              </dd>
            </dl>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              !funding || model.isLoading || Boolean(model.error) || Boolean(limitError) || isSaving
            }
            onClick={async () => {
              if (await model.save()) onClose();
            }}
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Save
            settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
