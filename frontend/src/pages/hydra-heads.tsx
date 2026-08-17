import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { ChevronDown, Plus, Ticket } from 'lucide-react';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { HydraInitDialog } from '@/components/hydra/HydraInitDialog';
import { HydraInvitesDialog } from '@/components/hydra/HydraManageDialog';
import { HydraNodeStrip } from '@/components/hydra/HydraNodeStrip';
import { HydraNodeDetailsDialog } from '@/components/hydra/HydraNodeDetailsDialog';
import { IssueHydraInviteDialog } from '@/components/hydra/IssueHydraInviteDialog';
import { RedeemHydraInviteDialog } from '@/components/hydra/RedeemHydraInviteDialog';
import { ConnectHydraNodeDialog } from '@/components/hydra/ConnectHydraNodeDialog';
import { BackUpNodeKeysDialog } from '@/components/hydra/BackUpNodeKeysDialog';
import { HydraHeadDetailsDialog } from '@/components/hydra/HydraHeadDetailsDialog';
import { HydraHeadTable } from '@/components/hydra/HydraHeadTable';
import { statusTabs, matchesStatusTab, type StatusTab } from '@/components/hydra/head-display';
import {
  getLifecycleActionConfirmCopy,
  type HydraLifecycleAction,
  type PendingLifecycleAction,
} from '@/components/hydra/head-lifecycle';
import type { HydraHost } from '@/lib/hooks/useHydraHosts';
import { useHydraHosts } from '@/lib/hooks/useHydraHosts';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoHint } from '@/components/ui/info-hint';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { Tabs } from '@/components/ui/tabs';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  closeHydraHead,
  commitHydraHead,
  fanoutHydraHead,
  initHydraHead,
  useHydraHeadReadiness,
  useHydraHeads,
  useHydraInvites,
  type HydraHead,
} from '@/lib/hooks/useHydraHeads';

export default function HydraHeadsPage() {
  const { apiClient, network } = useAppContext();
  const resync = useResync();
  // Scoped to the selected network, like the node strip. Heads from another
  // network would list with no node and link their hashes to the wrong chain.
  const selectedNetwork = network === 'Preprod' || network === 'Mainnet' ? network : undefined;
  const { heads, isLoading, isFetching, refetch } = useHydraHeads(selectedNetwork);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<StatusTab>('All');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isConnectNodeOpen, setIsConnectNodeOpen] = useState(false);
  const [isInvitesOpen, setIsInvitesOpen] = useState(false);
  const [isIssueInviteOpen, setIsIssueInviteOpen] = useState(false);
  const [isRedeemInviteOpen, setIsRedeemInviteOpen] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  // The id, not the host object. The dialog's own actions — check now, start
  // draining, disconnect — refetch the host list, and a stored snapshot cannot
  // see any of it: the badge kept saying Unreachable after a successful check,
  // and "Stop taking new heads" stayed on offer after the node was already
  // draining, so pressing it again re-sent the same request.
  const [detailsHostId, setDetailsHostId] = useState<string | null>(null);
  const { invites } = useHydraInvites(selectedNetwork);
  const inviteCount = invites.length;
  // Read here rather than through the nodes card: the card now lives in a
  // dialog, so leaving the count to it reported zero until the operator happened
  // to open one, and the page gates its primary action on this.
  const { hosts, error: hostsError, refetch: refetchHosts } = useHydraHosts(selectedNetwork);
  const [backUpKeysParticipantId, setBackUpKeysParticipantId] = useState<string | null>(null);
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null);
  const [runningLifecycleHeadId, setRunningLifecycleHeadId] = useState<string | null>(null);
  const [pendingLifecycleAction, setPendingLifecycleAction] =
    useState<PendingLifecycleAction | null>(null);
  // Looked up on every render, so the dialog shows whatever the last refetch
  // returned. A host that disappears from the list while its dialog is open
  // resolves to null, which the dialog already renders as nothing.
  const detailsHost = hosts.find((host) => host.id === detailsHostId) ?? null;

  const stats = useMemo(() => {
    const openHeads = heads.filter((head) => head.status === 'Open').length;
    const enabledHeads = heads.filter((head) => head.isEnabled).length;
    const activeHeads = heads.filter((head) =>
      ['Connected', 'Connecting', 'Initializing', 'Open'].includes(head.status),
    ).length;

    return {
      activeHeads,
      enabledHeads,
      openHeads,
      totalHeads: heads.length,
    };
  }, [heads]);

  // Invites nobody has redeemed are rows on the All tab, so All counts them.
  // Any other tab is a head status, which an invite does not have yet.
  const issuedInviteCount = useMemo(
    () => invites.filter((invite) => invite.role === 'Issuer' && invite.status === 'Issued').length,
    [invites],
  );

  const tabs = useMemo(
    () =>
      statusTabs.map((tab) => ({
        name: tab,
        count:
          heads.filter((head) => matchesStatusTab(head, tab)).length +
          (tab === 'All' ? issuedInviteCount : 0),
        variant: tab === 'Open' && stats.openHeads > 0 ? ('alert' as const) : undefined,
      })),
    [heads, issuedInviteCount, stats.openHeads],
  );

  const filteredHeads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return heads.filter((head) => {
      if (!matchesStatusTab(head, activeTab)) {
        return false;
      }

      // Selecting a node chip narrows the table to what that node runs, which
      // is the "heads inside their node" view without a second layout.
      if (selectedHostId !== null && head.LocalParticipant?.hydraHostId !== selectedHostId) {
        return false;
      }

      if (!query) {
        return true;
      }

      const localParticipant = head.LocalParticipant;
      const remoteParticipants = head.RemoteParticipants ?? [];
      const searchableValues = [
        head.id,
        head.hydraRelationId,
        head.headIdentifier ?? '',
        head.status,
        localParticipant?.walletId ?? '',
        localParticipant?.Wallet.walletAddress ?? '',
        localParticipant?.nodeUrl ?? '',
        localParticipant?.nodeHttpUrl ?? '',
        ...remoteParticipants.flatMap((participant) => [
          participant.walletId,
          participant.Wallet.walletAddress,
          participant.advertise,
        ]),
      ];

      return searchableValues.some((value) => value.toLowerCase().includes(query));
    });
  }, [activeTab, heads, searchQuery, selectedHostId]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 || activeTab !== 'All' || selectedHostId !== null;
  const selectedHead = useMemo(
    () => heads.find((head) => head.id === selectedHeadId) ?? null,
    [heads, selectedHeadId],
  );
  // A head has to run somewhere, so the action is unavailable until a node is
  // connected, which is the step above it on this page.
  const connectedNodeCount = hosts.length;
  // A head runs on exactly one node for its whole life, so this is a property of
  // the head rather than a join: the chip can say what it is carrying.
  const headCountsByHost = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const head of heads) {
      const hostId = head.LocalParticipant?.hydraHostId;
      if (hostId) counts[hostId] = (counts[hostId] ?? 0) + 1;
    }
    return counts;
  }, [heads]);
  const hasConnectedNode = connectedNodeCount > 0;
  const hostNames = useMemo(
    () => Object.fromEntries(hosts.map((host) => [host.id, host.name])),
    [hosts],
  );
  // Only ones we issued and nobody has taken: a redeemed invite already has a
  // head of its own in the list below, and showing both would double-count it.
  //
  // Filtered by the same controls as the heads beside them, or a search for one
  // head returned that head and every outstanding invite, and a status tab
  // claimed to show only Final while three "Awaiting counterparty" rows sat on
  // top of it. An invite has no status of its own to match a tab against — the
  // head it becomes does not exist yet — so it belongs to All alone.
  const pendingInvites = useMemo(() => {
    if (activeTab !== 'All') return [];
    const query = searchQuery.trim().toLowerCase();

    return invites.filter((invite) => {
      if (invite.role !== 'Issuer' || invite.status !== 'Issued') return false;
      if (selectedHostId !== null && invite.hydraHostId !== selectedHostId) return false;
      if (!query) return true;

      return [invite.id, invite.nonce, hostNames[invite.hydraHostId] ?? ''].some((value) =>
        value.toLowerCase().includes(query),
      );
    });
  }, [activeTab, hostNames, invites, searchQuery, selectedHostId]);
  const pendingLifecycleCopy = pendingLifecycleAction
    ? getLifecycleActionConfirmCopy(pendingLifecycleAction.head, pendingLifecycleAction.action)
    : null;
  /**
   * What the head being closed still holds, read before the dialog offers to
   * close it.
   *
   * The API refuses an unacknowledged close while a head holds escrows, and the
   * refusal is the explanation. Asking first means the confirmation can carry
   * that explanation and take the answer in the same step, instead of the
   * operator meeting it as a failed action and confirming in a second dialog.
   * Same query key as the action menu's, so it is usually already cached.
   */
  const { connection: closingHeadConnection, refetch: refetchClosingHeadConnection } =
    useHydraHeadReadiness(
      pendingLifecycleAction?.action === 'close' ? pendingLifecycleAction.head.id : null,
      pendingLifecycleAction?.action === 'close',
    );
  const closeWithActiveWork =
    pendingLifecycleAction?.action === 'close'
      ? (closingHeadConnection?.closeWithActiveWork ?? null)
      : null;

  const handleRunLifecycleAction = async (head: HydraHead, action: HydraLifecycleAction) => {
    setRunningLifecycleHeadId(head.id);
    // A refused close leaves the dialog up: the reason is usually work that
    // appeared since it opened, and the answer to it is the acknowledgement in
    // this same dialog. Closing the window would make the operator find the
    // head and the action again to answer a question they were just asked.
    let keepDialogOpen = false;
    try {
      if (action === 'init') {
        await initHydraHead(apiClient, { headId: head.id });
        toast.success('Hydra head init started');
      } else if (action === 'commit') {
        await commitHydraHead(apiClient, { headId: head.id });
        toast.success('Local Hydra commit submitted');
      } else if (action === 'close') {
        try {
          // Acknowledged only when the operator was told what they were
          // acknowledging: the checkbox is only shown when this is non-null.
          await closeHydraHead(apiClient, {
            headId: head.id,
            acknowledgeActiveEscrows: closeWithActiveWork !== null,
          });
        } catch (error) {
          // This call throws instead of toasting, so reporting it here is what
          // keeps a failed close from failing silently. An escrow that appeared
          // between the read and the press lands here too — refreshing the
          // readiness puts the acknowledgement in the dialog on the retry.
          toast.error(error instanceof Error ? error.message : String(error));
          keepDialogOpen = true;
          void refetchClosingHeadConnection();
          return;
        }
        toast.success('Hydra head close started');
      } else {
        await fanoutHydraHead(apiClient, { headId: head.id });
        toast.success('Hydra head fanout started');
      }

      // Everything about this head just changed: its status, its participants,
      // its transactions and its balance. Refetching only the list left the
      // dialog the operator is looking at describing the previous state.
      await resync('hydra');
      await refetch();
    } catch (error) {
      // init, commit and fanout report through the API layer, which toasts the
      // cause and then throws past the resync below. Without this the throw
      // left the handler as an unhandled rejection and the table kept showing
      // the status the action failed to change.
      console.error(`Hydra head ${action} failed`, error);
      await refetch();
    } finally {
      setRunningLifecycleHeadId(null);
      if (!keepDialogOpen) setPendingLifecycleAction(null);
    }
  };

  const handleConfirmLifecycleAction = () => {
    if (!pendingLifecycleAction) {
      return;
    }

    void handleRunLifecycleAction(pendingLifecycleAction.head, pendingLifecycleAction.action);
  };

  return (
    <MainLayout>
      <Head>
        <title>Hydra | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">Hydra</h1>
                <Badge variant="outline">Cardano L2</Badge>
              </div>
              {/* Two objects, said once. Operators kept asking what the
                  difference was, and an invite looked like a third thing to
                  learn rather than the first stage of a head's life. */}
              {/* One sentence on screen. The rest is the same explanation, kept
                  for the first visit and out of the way on every visit after. */}
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                Instant payments between two wallets, off chain.
                <InfoHint label="relationship between nodes and heads">
                  <p>
                    A <span className="text-foreground">node</span> is a machine you connect once. A{' '}
                    <span className="text-foreground">head</span> is one channel with one
                    counterparty, and runs on exactly one node for its whole life.
                  </p>
                  <p>
                    Inviting someone opens a head. It appears below as awaiting counterparty until
                    they accept.
                  </p>
                </InfoHint>
              </p>
            </div>

            <RefreshButton onRefresh={() => void resync('hydra')} isRefreshing={isFetching} />
          </div>

          <HydraNodeStrip
            hosts={hosts}
            loadFailed={hostsError != null}
            onRetry={() => void refetchHosts()}
            headCounts={headCountsByHost}
            selectedHostId={selectedHostId}
            onSelectHost={setSelectedHostId}
            onOpenHost={(host) => setDetailsHostId(host.id)}
            onAddNode={() => setIsConnectNodeOpen(true)}
          />

          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => setActiveTab(tab as StatusTab)}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search head ID, relation, participant wallet, or node..."
              className="max-w-md"
              isLoading={isFetching && !isLoading}
            />
            {/* The head action sits with the list it adds to, beside the
                search. Opening a head is one action with two ways in, so it is
                one button with a menu rather than two competing buttons. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  disabled={!hasConnectedNode}
                  title={
                    hasConnectedNode
                      ? undefined
                      : 'Connect a node first. A head has to run somewhere.'
                  }
                >
                  <Plus className="h-4 w-4" />
                  New head
                  <ChevronDown className="h-4 w-4 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onClick={() => setIsIssueInviteOpen(true)}>
                  <Ticket className="h-4 w-4" />
                  Invite someone
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsRedeemInviteOpen(true)}>
                  <Ticket className="h-4 w-4" />
                  Redeem an invite
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setIsInvitesOpen(true)}>
                  Manage invites{inviteCount > 0 ? ` (${inviteCount})` : ''}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <HydraHeadTable
            heads={filteredHeads}
            pendingInvites={pendingInvites}
            hostNames={hostNames}
            onManageInvites={() => setIsInvitesOpen(true)}
            isLoading={isLoading}
            hasActiveFilters={hasActiveFilters}
            runningLifecycleHeadId={runningLifecycleHeadId}
            onOpenHead={(head) => setSelectedHeadId(head.id)}
            onRequestLifecycle={(head, action) => setPendingLifecycleAction({ head, action })}
          />
        </div>
      </AnimatedPage>
      <HydraHeadDetailsDialog
        head={selectedHead}
        open={Boolean(selectedHead)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedHeadId(null);
          }
        }}
        network={network}
        isLifecycleActionRunning={selectedHead ? runningLifecycleHeadId === selectedHead.id : false}
        onRequestLifecycle={(head, action) => setPendingLifecycleAction({ head, action })}
        onBackUpKeys={(head) => setBackUpKeysParticipantId(head.LocalParticipant?.id ?? null)}
      />
      {/* Init has a precondition the others do not: the node must be able to pay
          for the transaction it is about to post. */}
      <HydraInitDialog
        open={pendingLifecycleAction?.action === 'init'}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingLifecycleAction(null);
        }}
        localParticipantId={pendingLifecycleAction?.head.LocalParticipant?.id ?? null}
        onConfirm={handleConfirmLifecycleAction}
        isRunning={
          pendingLifecycleAction ? runningLifecycleHeadId === pendingLifecycleAction.head.id : false
        }
      />
      {/* One dialog for every lifecycle action but init, including the close of
          a head that still holds escrows. That close is offered, not refused —
          the dialog exists to price it: settling inside the head takes about a
          second per escrow and costs nothing, closing swaps that for the
          contestation period plus an L1 settlement each. So it is the same
          question with one more thing to agree to, not a second dialog. */}
      <ConfirmDialog
        open={Boolean(pendingLifecycleAction) && pendingLifecycleAction?.action !== 'init'}
        onClose={() => setPendingLifecycleAction(null)}
        title={
          closeWithActiveWork !== null
            ? 'Closing now will take a while'
            : (pendingLifecycleCopy?.title ?? 'Confirm Hydra action')
        }
        description={
          // Appended, not substituted: the base copy is what names the head, and
          // an operator running several heads reads that first.
          [pendingLifecycleCopy?.description, closeWithActiveWork]
            .filter((part) => part != null && part !== '')
            .join('\n\n') || 'Confirm that you want to run this Hydra head lifecycle action.'
        }
        acknowledgementLabel={
          closeWithActiveWork !== null
            ? 'I understand what is still in the head will settle on L1 instead'
            : undefined
        }
        confirmLabel={closeWithActiveWork !== null ? 'Close anyway' : 'Confirm'}
        onConfirm={handleConfirmLifecycleAction}
        isLoading={
          pendingLifecycleAction ? runningLifecycleHeadId === pendingLifecycleAction.head.id : false
        }
        loadingNote="Posted to the node. This carries on without the window, and the head's status updates on its own — you can close this."
      />
      <BackUpNodeKeysDialog
        open={backUpKeysParticipantId !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setBackUpKeysParticipantId(null);
        }}
        participantId={backUpKeysParticipantId}
        onDone={() => void refetch()}
      />
      <HydraInvitesDialog
        open={isInvitesOpen}
        onOpenChange={setIsInvitesOpen}
        hasConnectedNode={hasConnectedNode}
      />
      <HydraNodeDetailsDialog
        host={detailsHost}
        open={detailsHostId !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDetailsHostId(null);
        }}
      />
      <IssueHydraInviteDialog
        open={isIssueInviteOpen}
        onOpenChange={setIsIssueInviteOpen}
        // The invite becomes an "awaiting counterparty" row built from the
        // invites query, not the heads query, so refetching heads alone left the
        // page looking as though nothing had been issued.
        onIssued={() => void resync('hydra')}
      />
      <RedeemHydraInviteDialog
        open={isRedeemInviteOpen}
        onOpenChange={setIsRedeemInviteOpen}
        onRedeemed={() => void refetch()}
      />
      <ConnectHydraNodeDialog
        open={isConnectNodeOpen}
        onOpenChange={setIsConnectNodeOpen}
        onConnected={() => void refetch()}
      />
    </MainLayout>
  );
}
