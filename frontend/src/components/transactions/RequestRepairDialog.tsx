import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  postRequestRepair,
  postRequestRepairPreview,
  type PostRequestRepairPreviewResponses,
} from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { formatOnChainState } from './transaction-format.helpers';

type RepairPreview = PostRequestRepairPreviewResponses[200]['data'];
type OnChainState = RepairPreview['derivedOnChainState'];

const ON_CHAIN_STATES: OnChainState[] = [
  'FundsLocked',
  'FundsOrDatumInvalid',
  'ResultSubmitted',
  'RefundRequested',
  'Disputed',
  'WithdrawAuthorized',
  'RefundAuthorized',
  'Withdrawn',
  'RefundWithdrawn',
  'DisputedWithdrawn',
];

const TX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

interface RequestRepairDialogProps {
  open: boolean;
  onClose: () => void;
  /** Purchase or payment — decides which table the blockchainIdentifier is looked up in. */
  kind: 'Purchase' | 'Payment';
  network: NetworkType;
  blockchainIdentifier: string;
  requestUpdatedAt: Date;
  onRepaired: () => void;
}

/**
 * Repoints a request at a specific transaction, preview first.
 *
 * The preview is a dry run against the chain: it fetches the transaction,
 * matches it to this request, and reports the state it would write. Apply is
 * only offered once that has succeeded for the hash currently in the field, so
 * an operator never commits to a repair they have not seen the result of.
 *
 * Force skips every one of those checks and writes the state given here. It is
 * behind Advanced deliberately — a wrong hash under force points the request at
 * someone else's escrow, which the automatic refund/withdraw logic then acts on.
 */
export function RequestRepairDialog({
  open,
  onClose,
  kind,
  network,
  blockchainIdentifier,
  requestUpdatedAt,
  onRepaired,
}: RequestRepairDialogProps) {
  const { apiClient } = useAppContext();
  const [txHash, setTxHash] = useState('');
  const [preview, setPreview] = useState<RepairPreview | null>(null);
  /** The hash the preview describes; a later edit invalidates it. */
  const [previewedHash, setPreviewedHash] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [force, setForce] = useState(false);
  const [forcedState, setForcedState] = useState<OnChainState | ''>('');

  useEffect(() => {
    if (!open) return;
    setTxHash('');
    setPreview(null);
    setPreviewedHash(null);
    setPreviewError(null);
    setShowAdvanced(false);
    setForce(false);
    setForcedState('');
  }, [open]);

  const trimmedHash = txHash.trim();
  const isHashValid = TX_HASH_PATTERN.test(trimmedHash);
  const currentRequestVersion =
    preview != null && previewedHash === trimmedHash ? preview.requestVersion : undefined;
  const isPreviewCurrent = currentRequestVersion != null;

  const handlePreview = useCallback(async () => {
    setIsPreviewing(true);
    setPreview(null);
    setPreviewedHash(null);
    setPreviewError(null);
    try {
      const response = await postRequestRepairPreview({
        client: apiClient,
        body: { kind, network, blockchainIdentifier, txHash: trimmedHash },
      });

      if (response.error) {
        // The 400 detail names the exact check that failed, so show it as-is
        // rather than replacing it with a generic message.
        setPreviewError(extractApiErrorMessage(response.error, 'The repair preview failed'));
        return;
      }

      const data = response.data?.data;
      if (!data) {
        setPreviewError('The repair preview returned no result');
        return;
      }

      if (data.requestVersion.length === 0) {
        setPreviewError('The repair preview returned no request version');
        return;
      }

      setPreview(data);
      setPreviewedHash(trimmedHash);
    } catch (error) {
      setPreviewError(extractApiErrorMessage(error, 'The repair preview failed'));
    } finally {
      setIsPreviewing(false);
    }
  }, [apiClient, blockchainIdentifier, kind, network, trimmedHash]);

  const handleApply = useCallback(async () => {
    if (!force && currentRequestVersion == null) {
      toast.error('Preview the current transaction hash before applying the repair');
      return;
    }

    setIsApplying(true);
    try {
      const body = {
        kind,
        network,
        blockchainIdentifier,
        txHash: trimmedHash,
        ...(currentRequestVersion != null
          ? { requestVersion: currentRequestVersion }
          : { expectedRequestUpdatedAt: requestUpdatedAt }),
        ...(force ? { force: true, onChainState: forcedState as OnChainState } : {}),
      };
      const response = await postRequestRepair({
        client: apiClient,
        body,
      });

      if (response.error) {
        toast.error(extractApiErrorMessage(response.error, 'The repair failed'));
        return;
      }

      const data = response.data?.data;
      // The repair only repoints the transaction and syncs the on-chain state.
      // It deliberately does not touch NextAction, so a request parked in an
      // error state stays parked until Retry/Clear is used — say so, or the
      // operator reasonably assumes the repair finished the job.
      toast.success(
        data
          ? `Request repaired — on-chain state is now ${formatOnChainState(data.newOnChainState)}${
              data.forced ? ' (forced)' : ''
            }. If the request is in an error state, use Retry or Clear to resume it.`
          : 'Request repaired. If the request is in an error state, use Retry or Clear to resume it.',
      );
      onRepaired();
      onClose();
    } catch (error) {
      toast.error(extractApiErrorMessage(error, 'The repair failed'));
    } finally {
      setIsApplying(false);
    }
  }, [
    apiClient,
    blockchainIdentifier,
    currentRequestVersion,
    force,
    forcedState,
    kind,
    network,
    onClose,
    onRepaired,
    requestUpdatedAt,
    trimmedHash,
  ]);

  const canApply = force
    ? isHashValid && forcedState !== ''
    : isPreviewCurrent && !isPreviewing && !isApplying;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Repair Request</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 w-full">
          <p className="text-sm text-muted-foreground">
            Points this {kind.toLowerCase()} at a specific transaction and syncs its on-chain state
            from that transaction&apos;s datum. Use it when the database has fallen behind the chain
            for this request.
          </p>

          <FormField
            label="Transaction hash"
            htmlFor="repair-tx-hash"
            required
            hint="The 64-character hash of the transaction this request should point at."
            error={
              trimmedHash !== '' && !isHashValid
                ? 'A transaction hash is 64 hexadecimal characters'
                : undefined
            }
          >
            <Input
              id="repair-tx-hash"
              value={txHash}
              onChange={(event) => setTxHash(event.target.value)}
              placeholder="0000000000000000000000000000000000000000000000000000000000000000"
              className="font-mono"
              disabled={isApplying}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={handlePreview}
              disabled={!isHashValid || isPreviewing || isApplying}
            >
              {isPreviewing ? 'Checking the chain...' : 'Preview'}
            </Button>
            {isPreviewCurrent && (
              <span className="text-xs text-muted-foreground">
                Checked against the chain. Nothing has been written yet.
              </span>
            )}
          </div>

          {previewError && (
            <div className="rounded-md bg-destructive/15 p-4 space-y-1">
              <h5 className="text-sm font-medium">Preview failed</h5>
              <p className="text-sm break-words">{previewError}</p>
            </div>
          )}

          {isPreviewCurrent && preview && (
            <div className="rounded-md border p-4 bg-muted/10 space-y-3">
              <h5 className="text-sm font-medium">What applying this would change</h5>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {preview.currentOnChainState
                    ? formatOnChainState(preview.currentOnChainState)
                    : 'No on-chain state'}
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">
                  {formatOnChainState(preview.derivedOnChainState)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h6 className="text-sm font-medium mb-1">Output index</h6>
                  <p className="text-sm">{preview.outputIndex}</p>
                </div>
                <div>
                  <h6 className="text-sm font-medium mb-1">Result hash</h6>
                  <p className="text-sm font-mono break-all">{preview.resultHash ?? '—'}</p>
                </div>
              </div>
            </div>
          )}

          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="px-2">
                {showAdvanced ? (
                  <ChevronDown className="h-4 w-4 mr-1" />
                ) : (
                  <ChevronRight className="h-4 w-4 mr-1" />
                )}
                Advanced
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-4 space-y-4">
                <div className="space-y-1">
                  <h5 className="text-sm font-medium">Force without chain validation</h5>
                  <p className="text-sm">
                    Forcing skips every check — the transaction is not fetched, its datum is not
                    decoded, and it is not matched against this request. The state you pick below is
                    written verbatim. A wrong hash here points the request at another escrow, and
                    the automatic refund and withdraw logic will act on it.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id="repair-force"
                    checked={force}
                    onCheckedChange={(checked) => {
                      setForce(checked);
                      if (!checked) setForcedState('');
                    }}
                    disabled={isApplying}
                  />
                  <label htmlFor="repair-force" className="text-sm font-medium">
                    Skip validation and write the state I choose
                  </label>
                </div>
                {force && (
                  <FormField label="On-chain state to write" required>
                    <Select
                      value={forcedState}
                      onValueChange={(value) => setForcedState(value as OnChainState)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a state" />
                      </SelectTrigger>
                      <SelectContent>
                        {ON_CHAIN_STATES.map((state) => (
                          <SelectItem key={state} value={state}>
                            {formatOnChainState(state)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={isApplying}>
              Cancel
            </Button>
            <Button
              variant={force ? 'destructive' : 'default'}
              onClick={handleApply}
              disabled={!canApply || isApplying}
            >
              {isApplying ? 'Applying...' : force ? 'Force repair' : 'Apply repair'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
