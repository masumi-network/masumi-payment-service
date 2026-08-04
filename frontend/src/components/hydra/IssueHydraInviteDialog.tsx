/**
 * Issue an invite to open a head with someone.
 *
 * Two things make this different from a form that just posts and closes.
 *
 * Issuing spends real capacity — a node process and a peer port, held until
 * someone redeems or it expires — so the cost is stated before the button, not
 * discovered afterwards from a node list.
 *
 * And the result is the whole point. The code is what the operator carries to
 * the counterparty, so the dialog stays open on it, offers a copy, and says
 * plainly that it is not a secret but is single-use.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2, Ticket } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DurationPicker, formatDuration } from '@/components/hydra/DurationPicker';
import { HydraDetailSection } from '@/components/hydra/HydraDetailSection';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useWallets } from '@/lib/queries/useWallets';
import { createHydraInvite } from '@/lib/hooks/useHydraHeads';
import { InfoHint } from '@/components/ui/info-hint';

type IssueHydraInviteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: () => void;
};

const HOUR_SECONDS = 3600;
const DEFAULT_TTL_HOURS = 168;
/** The longest the API accepts, and as long as a reservation is worth holding. */
const MAX_TTL_HOURS = 720;

/**
 * How long money added to the head waits before it can be used.
 *
 * Ten minutes on a testnet, where a rollback costs nothing. The floor is two:
 * a node measures a deposit's age in its own chain time, which trails real time
 * by around half a minute here, and the window in which any node will take the
 * deposit is only one period wide. Below a couple of minutes that window is the
 * same size as the jitter it has to survive.
 */
const MIN_SETTLE_MINUTES = 2;

/**
 * Defaults per network, matching what the service would pick on its own.
 *
 * They pull in opposite directions. Settle time is a cost on every top-up, so
 * it wants to be short — but on mainnet it is how long a rollback has to be
 * ruled out before real funds count, so twenty minutes buys confidence for a
 * wait an operator will accept. The dispute window is the reverse: it is the
 * only protection against a counterparty closing on a stale state, and the cost
 * of a long one is merely that settling takes longer, so it is sized for an
 * outage rather than a slow block: five days on mainnet, twelve hours on a
 * testnet where the worst case is a re-run.
 */
function defaultsFor(network: string) {
  const isMainnet = network === 'Mainnet';
  const contestation = isMainnet ? 5 * 24 * 3600 : 12 * 3600;
  return {
    settleMinutes: isMainnet ? 20 : 10,
    contestation,
    // Hydra's own rule, and a ceiling rather than a preference: an in-sync node
    // is guaranteed half the dispute window to see an on-chain event and react.
    unsynced: Math.floor(contestation / 2),
  };
}

export function IssueHydraInviteDialog({
  open,
  onOpenChange,
  onIssued,
}: IssueHydraInviteDialogProps) {
  const { apiClient, network } = useAppContext();
  const { wallets } = useWallets();
  const defaults = defaultsFor(network);
  const [hotWalletId, setHotWalletId] = useState('');
  const [ttlSeconds, setTtlSeconds] = useState(DEFAULT_TTL_HOURS * HOUR_SECONDS);
  const [settleSeconds, setSettleSeconds] = useState(defaults.settleMinutes * 60);
  const [contestationSeconds, setContestationSeconds] = useState(defaults.contestation);
  const [unsyncedSeconds, setUnsyncedSeconds] = useState(defaults.unsynced);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);

  function reset() {
    setHotWalletId('');
    setTtlSeconds(DEFAULT_TTL_HOURS * HOUR_SECONDS);
    setSettleSeconds(defaults.settleMinutes * 60);
    setContestationSeconds(defaults.contestation);
    setUnsyncedSeconds(defaults.unsynced);
    setIssued(null);
    setErrors({});
    setAdvancedOpen(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      reset();
    }
    onOpenChange(nextOpen);
  }

  /**
   * Every problem with the form, keyed by field.
   *
   * A toast names the problem and then takes it away, leaving the operator to
   * find which of five fields it meant. These render next to the input and stay
   * until it is fixed.
   */
  function validate(): Record<string, string> {
    const problems: Record<string, string> = {};
    if (hotWalletId.length === 0) {
      problems.wallet = 'Choose the wallet that will identify you on this head.';
    }
    // The API takes whole hours, so anything under one would round to nothing.
    if (ttlSeconds < HOUR_SECONDS || ttlSeconds > MAX_TTL_HOURS * HOUR_SECONDS) {
      problems.ttl = `Between an hour and ${MAX_TTL_HOURS / 24} days.`;
    }
    if (settleSeconds < MIN_SETTLE_MINUTES * 60) {
      problems.settle = `Funds need at least ${MIN_SETTLE_MINUTES} minutes to settle.`;
    }
    if (contestationSeconds < 60) {
      problems.contestation = 'The dispute window must be at least a minute.';
    }
    if (unsyncedSeconds < 60) {
      problems.unsynced = 'The out-of-sync limit must be at least a minute.';
    } else if (unsyncedSeconds > Math.floor(contestationSeconds / 2)) {
      problems.unsynced = `Cannot exceed half the dispute window (${formatDuration(Math.floor(contestationSeconds / 2))}).`;
    }
    return problems;
  }

  async function handleIssue() {
    const problems = validate();
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      // The section holding the problem may be collapsed, so open it rather than
      // let the operator hunt for a message they cannot see.
      if (problems.contestation !== undefined || problems.unsynced !== undefined) {
        setAdvancedOpen(true);
      }
      return;
    }

    setIsLoading(true);
    try {
      const invite = await createHydraInvite(apiClient, {
        hotWalletId,
        ttlHours: Math.floor(ttlSeconds / HOUR_SECONDS),
        depositPeriodSeconds: settleSeconds,
        contestationPeriodSeconds: contestationSeconds,
        unsyncedPeriodSeconds: unsyncedSeconds,
      });
      setIssued({ code: invite.code, expiresAt: invite.expiresAt });
      onIssued();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create the invite');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="h-4 w-4" />
            Invite someone to open a head
          </DialogTitle>
          <DialogDescription>
            You get a code to send them. When they redeem it, they open the head. Nothing further to
            do on this side.
          </DialogDescription>
        </DialogHeader>

        {issued === null ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="hydra-invite-wallet">Our wallet</Label>
              <Select
                value={hotWalletId}
                onValueChange={(value) => {
                  setHotWalletId(value);
                  setErrors({});
                }}
              >
                <SelectTrigger id="hydra-invite-wallet">
                  <SelectValue placeholder="Choose a wallet" />
                </SelectTrigger>
                <SelectContent>
                  {wallets.map((wallet) => (
                    <SelectItem key={wallet.id} value={wallet.id}>
                      {/* The role is always shown, even when the wallet has a
                          note. A head is between two wallets and which side
                          each plays decides whether payments can route through
                          it — a name alone does not say that. */}
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="shrink-0">
                          {wallet.type === 'Purchasing' ? 'Buyer' : 'Seller'}
                        </Badge>
                        <span className="truncate">
                          {wallet.note?.trim() ? `${wallet.note.trim()} · ` : ''}
                          {wallet.walletAddress.slice(0, 16)}…
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* One line of consequence, three paragraphs of detail behind the
                  icon. All of it was true and none of it was read: an operator
                  choosing from a two-item list does not stop to read six lines
                  first. */}
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Who you settle with, and what the counterparty must match.
                <InfoHint label="wallet on this invite">
                  <p>
                    This wallet signs the invite and is who the counterparty sees. It is who you
                    settle with, not the node&apos;s own key.
                  </p>
                  <p>
                    It also fixes their side: pick a buying wallet and they must redeem with a
                    selling one, and the other way round. A head carries payments in one direction
                    only.
                  </p>
                  <p>
                    Once they redeem, about 10 ADA moves from this wallet to the node to cover the
                    head&apos;s on-chain fees. Nothing leaves the wallet while the invite is unused,
                    and this is separate from whatever you later put into the head.
                  </p>
                </InfoHint>
              </p>
              {errors.wallet && <p className="text-xs text-destructive">{errors.wallet}</p>}
            </div>

            {/* The same control as the periods below it. A week expressed as
                "168" in an hours box is a number an operator has to decode, and
                it was the only duration on this form that worked differently
                from the rest. */}
            <DurationPicker
              id="hydra-invite-ttl"
              label="Invite valid for"
              seconds={ttlSeconds}
              onChange={(next) => {
                setTtlSeconds(next);
                setErrors({});
              }}
              error={errors.ttl}
              hint={
                <p>
                  How long the node and peer port stay reserved for this invite. Long enough that
                  the counterparty gets round to reading it.
                </p>
              }
            />

            <DurationPicker
              id="hydra-invite-settle"
              label="Added funds settle after"
              seconds={settleSeconds}
              onChange={(next) => {
                setSettleSeconds(next);
                setErrors({});
              }}
              showDays={false}
              hint={
                <>
                  <p>
                    Money moved into this head is unusable for this long, and cannot be recovered
                    for three times it.
                  </p>
                  <p>
                    Both nodes run the value you set here, and it is fixed once the head exists.
                  </p>
                </>
              }
              error={errors.settle}
              warning={
                settleSeconds < 5 * 60
                  ? 'Under five minutes is fragile: the window in which the head can take a deposit is the same length again, and chain time runs about half a minute behind.'
                  : null
              }
            />

            {/* Read once, if ever. The settle time above has a cost on every
                top-up; these two only matter when a head is being closed or a
                node falls behind. */}
            <HydraDetailSection
              title="Advanced"
              summary={`${formatDuration(contestationSeconds)} dispute window`}
              defaultOpen={advancedOpen}
            >
              <div className="space-y-4">
                <DurationPicker
                  id="hydra-invite-contestation"
                  label="Dispute window"
                  seconds={contestationSeconds}
                  onChange={(next) => {
                    setErrors({});
                    setContestationSeconds(next);
                    // The sync limit is capped at half, so it follows the window
                    // rather than silently becoming invalid behind a closed
                    // section.
                    setUnsyncedSeconds(Math.floor(next / 2));
                  }}
                  error={errors.contestation}
                  hint={
                    <>
                      <p>
                        After the head closes, how long either side may dispute the final state.
                        Nothing settles on chain until it passes, so it is also the wait between
                        closing the head and having the funds back.
                      </p>
                      <p>
                        Long is the safe direction: it is what protects you from a counterparty
                        closing on a stale state while your node is down.
                      </p>
                    </>
                  }
                />

                <DurationPicker
                  id="hydra-invite-unsynced"
                  label="Out-of-sync limit"
                  seconds={unsyncedSeconds}
                  onChange={(next) => {
                    setUnsyncedSeconds(next);
                    setErrors({});
                  }}
                  hint={
                    <>
                      <p>
                        How long a node may see no new block before it declares itself out of sync
                        and refuses commands, rather than acting on a stale view of the chain.
                      </p>
                      <p>
                        It cannot exceed half the dispute window (
                        {formatDuration(Math.floor(contestationSeconds / 2))} here): past that a
                        node can believe it is in sync while it has already run out of time to
                        contest a close.
                      </p>
                    </>
                  }
                  error={errors.unsynced}
                />
              </div>
            </HydraDetailSection>

            <HydraNotice tone="warn">
              <p>
                This starts a node and reserves a peer port right away, tied to this one invite. You
                cannot point it at someone else afterwards. Revoke it instead.
              </p>
            </HydraNotice>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Invite code</Label>
                <CopyButton value={issued.code} />
              </div>
              <p className="max-h-40 overflow-auto break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
                {issued.code}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Send it however you normally reach them. Nothing in it is secret, but it works once:
              whoever redeems it first becomes your counterparty.
            </p>
            <p className="text-xs text-muted-foreground">
              Expires {new Date(issued.expiresAt).toLocaleString()}.
            </p>
          </div>
        )}

        <DialogFooter>
          {issued === null ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleIssue()} disabled={isLoading}>
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Create invite
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
