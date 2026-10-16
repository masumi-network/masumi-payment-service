/**
 * The Details tab: reference material about one head.
 *
 * Who is in it, when it moved, and what was agreed when it was set up. Read
 * rarely and never in a hurry, so it lives behind its own tab rather than in
 * collapsibles under the things an operator checks every visit.
 */

import type { ReactNode } from 'react';
import { formatDuration } from '@/components/hydra/DurationPicker';
import {
  WalletRoleBadge,
  counterpartRole,
  type WalletRole,
} from '@/components/hydra/WalletRoleBadge';
import { Badge } from '@/components/ui/badge';
import { WalletLink } from '@/components/ui/wallet-link';
import type {
  HydraHead,
  HydraParticipant,
  HydraRemoteParticipant,
} from '@/lib/hooks/useHydraHeads';
import { DetailField, TransactionHashRow, formatDate } from '@/components/hydra/head-display';

export function HydraInfoSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

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
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No {title.toLowerCase()} saved.
      </div>
    );
  }

  const verificationKey =
    'HydraVerificationKey' in participant ? participant.HydraVerificationKey.hydraVK : null;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          {role && <WalletRoleBadge role={role} />}
        </div>
        <Badge variant={participant.hasCommitted ? 'success' : 'secondary'}>
          {participant.hasCommitted ? 'Committed' : 'Not committed'}
        </Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase text-muted-foreground">Wallet</p>
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
        label="Commit tx"
        hash={participant.commitTxHash}
        network={network}
        // A head can open with an empty commit, so "never committed" is a normal
        // resting state rather than a gap in the record.
        pendingReason="Nothing was committed at open. Add funds to deposit into the head."
      />
    </div>
  );
}

export function HydraHeadInfoTab({
  head,
  network,
  onLocalWalletClick,
  walletClickFor,
}: {
  head: HydraHead;
  network: string;
  onLocalWalletClick?: () => void;
  /** The details opener for a remote wallet this service also holds, if it does. */
  walletClickFor: (walletVkey: string) => (() => void) | undefined;
}) {
  const remoteParticipants = head.RemoteParticipants ?? [];
  const localRole = head.LocalParticipant?.Wallet.type ?? null;

  return (
    <div className="space-y-8">
      <HydraInfoSection title="Participants">
        <div className="space-y-3">
          <ParticipantCard
            title="This node"
            participant={head.LocalParticipant}
            network={network}
            role={localRole}
            onWalletClick={onLocalWalletClick}
          />
          {remoteParticipants.length > 0 ? (
            remoteParticipants.map((participant, index) => (
              <ParticipantCard
                key={participant.id}
                title={remoteParticipants.length > 1 ? `Counterparty ${index + 1}` : 'Counterparty'}
                participant={participant}
                network={network}
                role={counterpartRole(localRole)}
                onWalletClick={walletClickFor(participant.Wallet.walletVkey)}
              />
            ))
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No counterparty saved.
            </div>
          )}
        </div>
      </HydraInfoSection>

      <HydraInfoSection title="Timeline">
        <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-3">
          <DetailField label="Created" value={formatDate(head.createdAt)} />
          <DetailField label="Opened" value={formatDate(head.openedAt)} />
          <DetailField label="Latest activity" value={formatDate(head.latestActivityAt)} />
          <DetailField label="Closed" value={formatDate(head.closedAt)} />
          <DetailField label="Finalized" value={formatDate(head.finalizedAt)} />
          <DetailField label="Updated" value={formatDate(head.updatedAt)} />
        </div>
      </HydraInfoSection>

      {/* The head's agreed parameters. Every one of them explains a wait an
          operator will otherwise read as a stall: why a deposit is not
          spendable yet, why a close is not settling yet, why a node that is
          behind refuses to sign. They are fixed when the invite is issued and
          cannot be changed afterwards. */}
      <HydraInfoSection title="Configuration">
        <div className="space-y-3 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <DetailField
              label="Dispute window"
              value={formatDuration(Number(head.contestationPeriod))}
              hint="After closing, how long the other side has to contest before the head can settle on chain."
            />
            <DetailField
              label="Deposit confirmation"
              value={head.Invite ? formatDuration(head.Invite.depositPeriodSeconds) : undefined}
              hint="How long added funds must sit on chain before they can be spent inside the head."
            />
            <DetailField
              label="Unsynced tolerance"
              value={head.Invite ? formatDuration(head.Invite.unsyncedPeriodSeconds) : undefined}
              hint="How far behind the chain a node may fall before it stops signing."
            />
          </div>
          {!head.Invite && (
            <p className="text-xs text-muted-foreground">
              Only the dispute window is recorded for heads not opened from an invite.
            </p>
          )}
        </div>
      </HydraInfoSection>

      <HydraInfoSection title="Identifiers">
        <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
          <DetailField
            label="Head identifier"
            value={head.headIdentifier}
            copyValue={head.headIdentifier}
            mono
          />
          <DetailField label="Record id" value={head.id} copyValue={head.id} mono />
        </div>
      </HydraInfoSection>
    </div>
  );
}
