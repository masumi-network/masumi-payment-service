/**
 * Everything known about one head, in one dialog.
 *
 * Split out of the Hydra page for size. The page owns the list and the actions;
 * this owns the reading of a single head, which is the larger half and changes
 * for its own reasons.
 */

import {
  Activity,
  AlertTriangle,
  ChevronDown,
  GitBranch,
  Info,
  KeyRound,
  Layers3,
  Wifi,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { HydraHeadErrors } from '@/components/hydra/HydraHeadErrors';
import { HydraHeadEnableNotice } from '@/components/hydra/HydraHeadEnableNotice';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { HydraHeadWallets } from '@/components/hydra/HydraHeadWallets';
import { HydraWalletLink } from '@/components/hydra/HydraWalletLink';
import { HydraHeadTransactions } from '@/components/hydra/HydraHeadTransactions';
import { formatDuration } from '@/components/hydra/DurationPicker';
import { HydraHeadConnectionPanel } from '@/components/hydra/HydraHeadConnection';
import { HydraDetailSection } from '@/components/hydra/HydraDetailSection';
import { HydraHeadInHeadBalance } from '@/components/hydra/HydraHeadInHeadBalance';
import { HydraHeadTopupButton } from '@/components/hydra/HydraHeadTopupButton';
import { HydraHeadWithdrawButton } from '@/components/hydra/HydraHeadWithdrawButton';
import { HeadStatusHint } from '@/components/hydra/hydra-hints';
import {
  WalletRoleBadge,
  counterpartRole,
  type WalletRole,
} from '@/components/hydra/WalletRoleBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InfoHint } from '@/components/ui/info-hint';
import { WalletLink } from '@/components/ui/wallet-link';
import {
  WalletDetailsDialog,
  type WalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { useWalletsByVkeys } from '@/lib/queries/useWallets';
import { toPaymentSourceWalletDetails } from '@/lib/wallet-lookup';
import { cn, getExplorerUrl, shortenAddress } from '@/lib/utils';
import type {
  HydraHead,
  HydraParticipant,
  HydraRemoteParticipant,
} from '@/lib/hooks/useHydraHeads';
import {
  DetailField,
  TransactionHashRow,
  formatDate,
  getParticipantSummary,
  getStatusBadgeVariant,
} from '@/components/hydra/head-display';
import {
  HydraLifecycleActionMenu,
  type HydraLifecycleAction,
} from '@/components/hydra/head-lifecycle';

function ParticipantCard({
  title,
  participant,
  network,
  role,
  onWalletClick,
}: {
  title: string;
  participant: HydraParticipant | HydraRemoteParticipant | null | undefined;
  network: string;
  /** Which side of the payment this participant is, when it is known. */
  role?: WalletRole | null;
  onWalletClick?: () => void;
}) {
  if (!participant) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No {title.toLowerCase()} participant saved.
      </div>
    );
  }

  const verificationKey =
    'HydraVerificationKey' in participant ? participant.HydraVerificationKey.hydraVK : null;

  return (
    <div className="space-y-4 rounded-md border bg-muted/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">
            Created {formatDate(participant.createdAt)}
          </p>
        </div>
        <Badge variant={participant.hasCommitted ? 'success' : 'secondary'}>
          {participant.hasCommitted ? 'Committed' : 'Not committed'}
        </Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          {/* A head carries payments one way, so which end a wallet is on is
              the fact that decides what this participant can do. It was
              readable only by knowing which wallet address was whose. */}
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">Wallet</p>
            {role && <WalletRoleBadge role={role} />}
          </div>
          <WalletLink
            address={participant.Wallet.walletAddress}
            vkey={participant.Wallet.walletVkey}
            network={network}
            shorten={10}
            onInternalClick={onWalletClick}
          />
        </div>
        {verificationKey && (
          <DetailField
            label="Hydra verification key"
            value={verificationKey}
            copyValue={verificationKey}
            mono
          />
        )}
        {'advertise' in participant ? (
          <DetailField
            label="Peer address"
            value={participant.advertise}
            copyValue={participant.advertise}
            mono
          />
        ) : (
          <>
            <DetailField
              label="Node WS"
              value={participant.nodeUrl}
              copyValue={participant.nodeUrl}
              mono
            />
            <DetailField
              label="Node HTTP"
              value={participant.nodeHttpUrl}
              copyValue={participant.nodeHttpUrl}
              mono
            />
          </>
        )}
      </div>

      <TransactionHashRow
        label={`${title} commit tx`}
        hash={participant.commitTxHash}
        network={network}
        // A head can open with an empty commit, so "never committed" is a normal
        // resting state rather than a gap in the record.
        pendingReason="Nothing was committed at open. Add funds to deposit into the head."
      />
    </div>
  );
}

export function HydraHeadDetailsDialog({
  head,
  open,
  onOpenChange,
  network,
  isLifecycleActionRunning,
  onRequestLifecycle,
  onBackUpKeys,
}: {
  head: HydraHead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: string;
  isLifecycleActionRunning: boolean;
  onRequestLifecycle: (head: HydraHead, action: HydraLifecycleAction) => void;
  onBackUpKeys: (head: HydraHead) => void;
}) {
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  const remoteWallet = head?.RemoteParticipants?.[0]?.Wallet;
  const remoteWalletVkeys = useMemo(
    () => head?.RemoteParticipants?.map((participant) => participant.Wallet.walletVkey) ?? [],
    [head],
  );
  const internalWallets = useWalletsByVkeys(remoteWalletVkeys);
  const localWalletForDetails = useMemo<WalletWithBalance | null>(() => {
    const participant = head?.LocalParticipant;
    if (!participant) return null;

    return {
      id: participant.walletId,
      walletVkey: participant.Wallet.walletVkey,
      walletAddress: participant.Wallet.walletAddress,
      collectionAddress: participant.Wallet.collectionAddress,
      note: participant.Wallet.note,
      type: participant.Wallet.type,
      balance: '0',
      usdcxBalance: '0',
    };
  }, [head]);
  const remoteWalletForDetails = remoteWallet
    ? internalWallets.get(remoteWallet.walletVkey)
    : undefined;

  if (!head) {
    return null;
  }

  const participantSummary = getParticipantSummary(head);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setSelectedWalletForDetails(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-w-4xl max-h-[90vh] overflow-y-auto"
        isPushedBack={!!selectedWalletForDetails}
      >
        <DialogHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>Hydra head details</DialogTitle>
                <Badge variant={getStatusBadgeVariant(head.status)}>{head.status}</Badge>
                <HeadStatusHint />
                {!head.isEnabled && <Badge variant="outline">Disabled</Badge>}
              </div>
              <DialogDescription>
                {head.headIdentifier
                  ? shortenAddress(head.headIdentifier, 10)
                  : shortenAddress(head.id, 10)}
              </DialogDescription>
            </div>
            <HydraLifecycleActionMenu
              head={head}
              isRunning={isLifecycleActionRunning}
              onRequestLifecycle={onRequestLifecycle}
            />
          </div>
        </DialogHeader>

        {/* What is read every visit stays open; reference material collapses.
            The wallets lead, because which two wallets a head is between is
            what decides whether a payment can use it at all. */}
        <div className="space-y-4">
          {/* Above the wallets, because a disabled head answers every other
              question on this screen: the balances still read as healthy and
              every action is greyed out. */}
          <HydraHeadEnableNotice head={head} />

          <HydraHeadWallets
            localWallet={head.LocalParticipant?.Wallet}
            localCardanoVkey={head.LocalParticipant?.cardanoVkey}
            localRole={head.LocalParticipant?.Wallet.type ?? null}
            remoteWallet={remoteWallet}
            remoteCardanoVkey={head.RemoteParticipants?.[0]?.cardanoVkey}
            remoteRole={counterpartRole(head.LocalParticipant?.Wallet.type)}
            network={network}
            onLocalWalletClick={
              localWalletForDetails
                ? () => setSelectedWalletForDetails(localWalletForDetails)
                : undefined
            }
            onRemoteWalletClick={
              remoteWalletForDetails
                ? () =>
                    setSelectedWalletForDetails(
                      toPaymentSourceWalletDetails(remoteWalletForDetails),
                    )
                : undefined
            }
          />

          {head.LocalParticipant && !head.LocalParticipant.keysDisclosedAt && (
            <HydraNotice
              tone="warn"
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onBackUpKeys(head)}
                >
                  <KeyRound className="h-4 w-4" />
                  Back up keys
                </Button>
              }
            >
              <p className="font-medium">
                This node&apos;s signing keys have never been backed up.
              </p>
              <p>They can be shown once, then the service seals them.</p>
            </HydraNotice>
          )}

          {head.reconciliationStalledTxId && (
            <HydraNotice tone="error">
              <p className="font-medium">This head has stopped syncing and needs an operator.</p>
              <p>
                A confirmed in-head transaction could not be processed
                {head.reconciliationStalledReason ? ` (${head.reconciliationStalledReason})` : ''},
                and every later sync pass stops at it. Payments on this head will not settle until
                it is cleared.
              </p>
              <p className="mt-1 font-mono text-xs break-all">{head.reconciliationStalledTxId}</p>
              {head.reconciliationStalledSince && (
                <p className="text-xs">
                  Stalled since {new Date(head.reconciliationStalledSince).toLocaleString()}
                </p>
              )}
            </HydraNotice>
          )}

          <HydraHeadConnectionPanel headId={head.id} />

          <HydraHeadInHeadBalance
            headId={head.id}
            isOpen={head.status === 'Open'}
            network={network}
          />

          <HydraHeadTopupButton headId={head.id} isOpen={head.status === 'Open'} />

          <HydraHeadWithdrawButton headId={head.id} isOpen={head.status === 'Open'} />

          {/* Open whenever there are any. The section only renders when the count
              is non-zero, so collapsing it by default meant the card advertised
              "2 errors" while the details underneath looked empty, which reads as
              though something had cleared them. */}
          {(head._count?.Errors ?? 0) > 0 && (
            <HydraDetailSection
              title="Errors"
              summary={`${head._count?.Errors ?? 0} recorded`}
              defaultOpen
            >
              <HydraHeadErrors
                headId={head.id}
                count={head._count?.Errors ?? 0}
                showHeading={false}
              />
            </HydraDetailSection>
          )}

          {/* Payments, not the head's own transactions. The two used to sit in
              one section under one word, so "Transactions" meant L2 payments at
              the top and the L1 open/close/settle steps one disclosure deeper,
              and the summary described the head's chain state while the content
              listed payments. Two questions, two sections, each named for what
              it answers. */}
          <HydraDetailSection
            title="Payments"
            summary={`${head._count?.Transactions ?? 0} in the head`}
            defaultOpen={head.status === 'Open'}
          >
            <HydraHeadTransactions headId={head.id} network={network} />
          </HydraDetailSection>

          <HydraDetailSection
            title="On-chain transactions"
            summary={head.fanoutTxHash ? 'Settled' : head.closeTxHash ? 'Closing' : 'Open'}
          >
            <div className="space-y-2">
              <TransactionHashRow
                label="Initial tx"
                hash={head.initTxHash}
                network={network}
                pendingReason="Not opened yet"
              />
              <TransactionHashRow
                label="Close tx"
                hash={head.closeTxHash}
                network={network}
                pendingReason={
                  head.status === 'Closed' || head.status === 'FanoutPossible'
                    ? 'Closing, hash not observed yet'
                    : 'Still open, nothing to close'
                }
              />
              <TransactionHashRow
                label="Fanout tx"
                hash={head.fanoutTxHash}
                network={network}
                pendingReason={
                  head.status === 'FanoutPossible'
                    ? 'Ready to fan out'
                    : 'Available once the head is closed and its dispute window has passed'
                }
              />
            </div>
          </HydraDetailSection>

          <HydraDetailSection
            title="Participants"
            summary={`${participantSummary.totalParticipants} total, ${participantSummary.committedCount} committed`}
          >
            <ParticipantCard
              title="Local participant"
              participant={head.LocalParticipant}
              network={network}
              role={head.LocalParticipant?.Wallet.type ?? null}
              onWalletClick={
                localWalletForDetails
                  ? () => setSelectedWalletForDetails(localWalletForDetails)
                  : undefined
              }
            />
            {(head.RemoteParticipants ?? []).length > 0 ? (
              (head.RemoteParticipants ?? []).map((participant, index) => {
                const internalWallet = internalWallets.get(participant.Wallet.walletVkey);
                return (
                  <ParticipantCard
                    key={participant.id}
                    title={`Remote participant ${index + 1}`}
                    participant={participant}
                    network={network}
                    role={counterpartRole(head.LocalParticipant?.Wallet.type ?? null)}
                    onWalletClick={
                      internalWallet
                        ? () =>
                            setSelectedWalletForDetails(
                              toPaymentSourceWalletDetails(internalWallet),
                            )
                        : undefined
                    }
                  />
                );
              })
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No remote participants saved.
              </div>
            )}
          </HydraDetailSection>

          <HydraDetailSection title="Identifiers and timeline" summary={formatDate(head.createdAt)}>
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-3">
                <DetailField
                  label="Head identifier"
                  value={head.headIdentifier ?? head.id}
                  copyValue={head.headIdentifier ?? head.id}
                  mono
                />
                <DetailField label="Snapshot" value={head.latestSnapshotNumber} />
                <DetailField label="Created" value={formatDate(head.createdAt)} />
                <DetailField label="Updated" value={formatDate(head.updatedAt)} />
                <DetailField label="Latest activity" value={formatDate(head.latestActivityAt)} />
                <DetailField label="Opened" value={formatDate(head.openedAt)} />
                <DetailField label="Closed" value={formatDate(head.closedAt)} />
                <DetailField label="Finalized" value={formatDate(head.finalizedAt)} />
              </div>

              {/* The head's agreed parameters. Every one of them explains a wait
                  an operator will otherwise read as a stall: why a deposit is
                  not spendable yet, why a close is not settling yet, why a node
                  that is behind refuses to sign. They are fixed when the invite
                  is issued and cannot be changed afterwards, which is exactly
                  why they belong on the head rather than in a settings screen. */}
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Configuration
                </p>
                <div className="grid gap-4 md:grid-cols-3">
                  <DetailField
                    label="Dispute window"
                    value={formatDuration(Number(head.contestationPeriod))}
                    hint="After closing, how long the other side has to contest before the head can settle on chain."
                  />
                  <DetailField
                    label="Deposit confirmation"
                    value={
                      head.Invite ? formatDuration(head.Invite.depositPeriodSeconds) : undefined
                    }
                    hint="How long added funds must sit on chain before they can be spent inside the head."
                  />
                  <DetailField
                    label="Unsynced tolerance"
                    value={
                      head.Invite ? formatDuration(head.Invite.unsyncedPeriodSeconds) : undefined
                    }
                    hint="How far behind the chain a node may fall before it stops signing."
                  />
                </div>
                {!head.Invite && (
                  <p className="text-xs text-muted-foreground">
                    Only the dispute window is recorded for heads not opened from an invite.
                  </p>
                )}
              </div>
            </div>
          </HydraDetailSection>
        </div>
      </DialogContent>
      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
        isChild
      />
    </Dialog>
  );
}
