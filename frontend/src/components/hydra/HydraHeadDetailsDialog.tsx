/**
 * Everything known about one head, in one dialog.
 *
 * Split into tabs by the question an operator opens it with. Overview: is this
 * head healthy and who is it between. Funds: what is in it and moving money.
 * Activity: what went through it. Errors: what went wrong, shown only when
 * something did. Details: reference material read rarely. One long column of
 * collapsibles answered all five at once and none of them quickly.
 *
 * The header stays put across tabs, so the status and the lifecycle actions
 * are always one glance and one click away.
 */

import { useMemo, useState } from 'react';
import { HeadStatusHint } from '@/components/hydra/hydra-hints';
import { HydraHeadErrors } from '@/components/hydra/HydraHeadErrors';
import { HydraHeadOverviewTab, type HydraHeadTab } from '@/components/hydra/HydraHeadOverviewTab';
import { HydraHeadFundsTab } from '@/components/hydra/HydraHeadFundsTab';
import { HydraHeadActivityTab } from '@/components/hydra/HydraHeadActivityTab';
import { HydraHeadInfoTab } from '@/components/hydra/HydraHeadInfoTab';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/tabs';
import {
  WalletDetailsDialog,
  type WalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { useWalletsByVkeys } from '@/lib/queries/useWallets';
import { toPaymentSourceWalletDetails } from '@/lib/wallet-lookup';
import { shortenAddress } from '@/lib/utils';
import type { HydraHead } from '@/lib/hooks/useHydraHeads';
import { getStatusBadgeVariant } from '@/components/hydra/head-display';
import {
  HydraLifecycleActionMenu,
  type HydraLifecycleAction,
} from '@/components/hydra/head-lifecycle';

type TabSpec = { name: HydraHeadTab; count?: number; variant?: 'alert' };

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
  // The tab is remembered per head, so a tab picked for one head never
  // carries over to the next one opened: every head opens on its Overview.
  const [tabState, setTabState] = useState<{ headId: string | null; tab: HydraHeadTab }>({
    headId: null,
    tab: 'Overview',
  });
  const activeTab = tabState.headId === head?.id ? tabState.tab : 'Overview';
  const setActiveTab = (tab: HydraHeadTab) => setTabState({ headId: head?.id ?? null, tab });

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

  if (!head) {
    return null;
  }

  const errorCount = head._count?.Errors ?? 0;
  // The Errors tab exists only while there are errors. Clearing them removes
  // the tab, so the reader falls back to Overview instead of an empty page.
  const tabs: TabSpec[] = [
    { name: 'Overview' },
    { name: 'Funds' },
    // No count: the list merges ledger rows, deposits and node funding, and
    // only the ledger rows have a count on the head.
    { name: 'Activity' },
    ...(errorCount > 0 ? [{ name: 'Errors', count: errorCount, variant: 'alert' } as TabSpec] : []),
    { name: 'Details' },
  ];
  const currentTab = tabs.some((tab) => tab.name === activeTab) ? activeTab : 'Overview';

  const onLocalWalletClick = localWalletForDetails
    ? () => setSelectedWalletForDetails(localWalletForDetails)
    : undefined;
  const walletClickFor = (walletVkey: string) => {
    const internal = internalWallets.get(walletVkey);
    return internal
      ? () => setSelectedWalletForDetails(toPaymentSourceWalletDetails(internal))
      : undefined;
  };
  const firstRemoteVkey = head.RemoteParticipants?.[0]?.Wallet.walletVkey;
  const headIdentifier = head.headIdentifier ?? head.id;
  const isOpen = head.status === 'Open';

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setSelectedWalletForDetails(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-h-[85vh] max-w-3xl flex-col px-0 pb-0"
        isPushedBack={!!selectedWalletForDetails}
      >
        <DialogHeader className="shrink-0 px-6">
          <div className="flex items-start justify-between gap-3 pr-8">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-lg">Hydra head</DialogTitle>
                <Badge variant={getStatusBadgeVariant(head.status)}>{head.status}</Badge>
                <HeadStatusHint />
                {!head.isEnabled && <Badge variant="outline">Disabled</Badge>}
              </div>
              <DialogDescription asChild>
                <div className="flex items-center gap-1 font-mono text-xs">
                  {shortenAddress(headIdentifier, 10)}
                  <CopyButton value={headIdentifier} className="h-6 w-6" />
                </div>
              </DialogDescription>
            </div>
            <HydraLifecycleActionMenu
              head={head}
              isRunning={isLifecycleActionRunning}
              onRequestLifecycle={onRequestLifecycle}
            />
          </div>
        </DialogHeader>

        <Tabs
          tabs={tabs}
          activeTab={currentTab}
          onTabChange={(name) => setActiveTab(name as HydraHeadTab)}
          className="mt-2 shrink-0 px-6"
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {currentTab === 'Overview' && (
            <HydraHeadOverviewTab
              head={head}
              network={network}
              onNavigate={setActiveTab}
              onBackUpKeys={onBackUpKeys}
              onLocalWalletClick={onLocalWalletClick}
              onRemoteWalletClick={firstRemoteVkey ? walletClickFor(firstRemoteVkey) : undefined}
            />
          )}
          {currentTab === 'Funds' && (
            <HydraHeadFundsTab headId={head.id} isOpen={isOpen} network={network} />
          )}
          {currentTab === 'Activity' && <HydraHeadActivityTab head={head} network={network} />}
          {currentTab === 'Errors' && (
            <HydraHeadErrors headId={head.id} count={errorCount} showHeading={false} />
          )}
          {currentTab === 'Details' && (
            <HydraHeadInfoTab
              head={head}
              network={network}
              onLocalWalletClick={onLocalWalletClick}
              walletClickFor={walletClickFor}
            />
          )}
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
