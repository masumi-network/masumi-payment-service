import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import {
  deleteInboxAgents,
  postInboxAgentsDeregister,
  RegistryInboxEntry,
} from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import formatBalance from '@/lib/formatBalance';
import { findPaymentSourceWalletByVkey } from '@/lib/wallet-lookup';
import { cn, handleApiCall, shortenAddress } from '@/lib/utils';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'react-toastify';

interface InboxAgentDetailsDialogProps {
  agent: RegistryInboxEntry | null;
  onClose: () => void;
  onSuccess?: () => void;
}

const parseInboxAgentStatus = (status: RegistryInboxEntry['state']): string => {
  switch (status) {
    case 'RegistrationRequested':
      return 'Pending';
    case 'RegistrationInitiated':
      return 'Registering';
    case 'RegistrationConfirmed':
      return 'Registered';
    case 'RegistrationFailed':
      return 'Registration Failed';
    case 'DeregistrationRequested':
      return 'Pending';
    case 'DeregistrationInitiated':
      return 'Deregistering';
    case 'DeregistrationConfirmed':
      return 'Deregistered';
    case 'DeregistrationFailed':
      return 'Deregistration Failed';
    default:
      return status;
  }
};

const getStatusBadgeVariant = (status: RegistryInboxEntry['state']) => {
  if (status === 'RegistrationConfirmed') return 'default';
  if (status.includes('Failed')) return 'destructive';
  if (status.includes('Initiated')) return 'secondary';
  if (status.includes('Requested')) return 'secondary';
  if (status === 'DeregistrationConfirmed') return 'secondary';
  return 'secondary';
};

function formatLovelaceToAda(amount: string) {
  return `${formatBalance((parseInt(amount, 10) / 1000000).toFixed(2))} ADA`;
}

function formatDate(date: Date | string | null | undefined) {
  if (!date) {
    return '—';
  }

  const value = typeof date === 'string' ? new Date(date) : date;
  return value.toLocaleString();
}

export function InboxAgentDetailsDialog({
  agent,
  onClose,
  onSuccess,
}: InboxAgentDetailsDialogProps) {
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );

  const holdingWallet = useMemo(
    () => (agent ? (agent.RecipientWallet ?? agent.SmartContractWallet) : null),
    [agent],
  );

  const usesCombinedWallet = useMemo(
    () =>
      agent != null &&
      holdingWallet != null &&
      holdingWallet.walletVkey === agent.SmartContractWallet.walletVkey,
    [agent, holdingWallet],
  );

  const actionLabel = useMemo(() => {
    if (agent?.state === 'RegistrationConfirmed') {
      return 'Deregister';
    }

    if (agent?.state === 'RegistrationFailed' || agent?.state === 'DeregistrationConfirmed') {
      return 'Delete';
    }

    return null;
  }, [agent?.state]);

  const handleWalletClick = useCallback(
    (walletVkey: string) => {
      const filteredSources = currentNetworkPaymentSources.filter((source) =>
        selectedPaymentSourceId ? source.id === selectedPaymentSourceId : true,
      );
      const wallet = findPaymentSourceWalletByVkey(filteredSources, walletVkey);

      if (!wallet) {
        toast.error('Wallet not found');
        return;
      }

      setSelectedWalletForDetails(wallet);
    },
    [currentNetworkPaymentSources, selectedPaymentSourceId],
  );

  const handleDeleteOrDeregister = useCallback(async () => {
    if (!agent) {
      return;
    }

    if (agent.state === 'RegistrationFailed' || agent.state === 'DeregistrationConfirmed') {
      setIsDeleting(true);
      await handleApiCall(
        () =>
          deleteInboxAgents({
            client: apiClient,
            body: {
              id: agent.id,
            },
          }),
        {
          onSuccess: () => {
            toast.success('Inbox agent deleted successfully');
            onClose();
            onSuccess?.();
          },
          onError: (error: unknown) => {
            toast.error(extractApiErrorMessage(error, 'Failed to delete inbox agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
            setIsDeleteDialogOpen(false);
          },
          errorMessage: 'Failed to delete inbox agent',
        },
      );
      return;
    }

    if (agent.state === 'RegistrationConfirmed') {
      if (!agent.agentIdentifier) {
        toast.error('Cannot deregister inbox agent: Missing identifier');
        return;
      }

      const selectedPaymentSource = currentNetworkPaymentSources.find(
        (paymentSource) => paymentSource.id === selectedPaymentSourceId,
      );
      if (!selectedPaymentSource) {
        toast.error('Cannot deregister inbox agent: Missing payment source');
        return;
      }

      setIsDeleting(true);
      await handleApiCall(
        () =>
          postInboxAgentsDeregister({
            client: apiClient,
            body: {
              agentIdentifier: agent.agentIdentifier!,
              network,
              smartContractAddress: selectedPaymentSource.smartContractAddress || undefined,
            },
          }),
        {
          onSuccess: () => {
            toast.success('Inbox agent deregistration initiated successfully');
            onClose();
            onSuccess?.();
          },
          onError: (error: unknown) => {
            toast.error(extractApiErrorMessage(error, 'Failed to deregister inbox agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
            setIsDeleteDialogOpen(false);
          },
          errorMessage: 'Failed to deregister inbox agent',
        },
      );
      return;
    }

    toast.error(
      'This inbox agent is not in a deletable state yet. Please wait for pending work to finish.',
    );
  }, [
    agent,
    apiClient,
    currentNetworkPaymentSources,
    network,
    onClose,
    onSuccess,
    selectedPaymentSourceId,
  ]);

  return (
    <>
      <Dialog open={!!agent && !isDeleteDialogOpen} onOpenChange={onClose}>
        <DialogContent
          className="max-w-[640px] max-h-[90vh] overflow-y-auto"
          isPushedBack={!!selectedWalletForDetails}
        >
          {agent && (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <DialogTitle>{agent.name}</DialogTitle>
                    <p className="text-sm text-muted-foreground mt-2">
                      Inbox slug: <span className="font-mono">{agent.agentSlug}</span>
                    </p>
                  </div>
                  <Badge
                    variant={getStatusBadgeVariant(agent.state)}
                    className={cn(
                      agent.state === 'RegistrationConfirmed' &&
                        'bg-green-50 text-green-700 hover:bg-green-50/80',
                    )}
                  >
                    {parseInboxAgentStatus(agent.state)}
                  </Badge>
                </div>
              </DialogHeader>

              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Overview</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div>
                      <div className="font-medium mb-1">Description</div>
                      <p className="text-muted-foreground">
                        {agent.description || 'No description provided'}
                      </p>
                    </div>

                    {agent.error && (
                      <div>
                        <div className="font-medium mb-1 text-destructive">Error</div>
                        <p className="text-destructive text-sm">{agent.error}</p>
                      </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="font-medium mb-1">Metadata version</div>
                        <div className="text-muted-foreground">{agent.metadataVersion}</div>
                      </div>
                      <div>
                        <div className="font-medium mb-1">Holding wallet funding</div>
                        <div className="text-muted-foreground">
                          {agent.sendFundingLovelace
                            ? formatLovelaceToAda(agent.sendFundingLovelace)
                            : 'Default minimum'}
                        </div>
                      </div>
                      <div>
                        <div className="font-medium mb-1">Created</div>
                        <div className="text-muted-foreground">{formatDate(agent.createdAt)}</div>
                      </div>
                      <div>
                        <div className="font-medium mb-1">Updated</div>
                        <div className="text-muted-foreground">{formatDate(agent.updatedAt)}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Identifier</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {agent.agentIdentifier ? (
                      <div className="flex items-center gap-2 font-mono text-xs break-all">
                        <span>{agent.agentIdentifier}</span>
                        <CopyButton value={agent.agentIdentifier} />
                      </div>
                    ) : (
                      <p className="text-muted-foreground">No on-chain identifier yet.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Wallets</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {holdingWallet && usesCombinedWallet ? (
                      <div>
                        <div className="font-medium mb-1">Minting &amp; holding wallet</div>
                        <div className="flex items-center gap-2 text-muted-foreground font-mono text-xs">
                          <button
                            type="button"
                            className="hover:text-primary text-left"
                            onClick={() => handleWalletClick(holdingWallet.walletVkey)}
                          >
                            {holdingWallet.walletAddress}
                          </button>
                          <CopyButton value={holdingWallet.walletAddress} />
                        </div>
                      </div>
                    ) : (
                      <>
                        <div>
                          <div className="font-medium mb-1">Minting wallet</div>
                          <div className="flex items-center gap-2 text-muted-foreground font-mono text-xs">
                            <button
                              type="button"
                              className="hover:text-primary text-left"
                              onClick={() =>
                                handleWalletClick(agent.SmartContractWallet.walletVkey)
                              }
                            >
                              {agent.SmartContractWallet.walletAddress}
                            </button>
                            <CopyButton value={agent.SmartContractWallet.walletAddress} />
                          </div>
                        </div>
                        {holdingWallet && (
                          <div>
                            <div className="font-medium mb-1">Holding wallet</div>
                            <div className="flex items-center gap-2 text-muted-foreground font-mono text-xs">
                              <button
                                type="button"
                                className="hover:text-primary text-left"
                                onClick={() => handleWalletClick(holdingWallet.walletVkey)}
                              >
                                {holdingWallet.walletAddress}
                              </button>
                              <CopyButton value={holdingWallet.walletAddress} />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>

                {agent.CurrentTransaction && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Current transaction</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <div className="font-medium mb-1">Status</div>
                          <div className="text-muted-foreground">
                            {agent.CurrentTransaction.status}
                          </div>
                        </div>
                        <div>
                          <div className="font-medium mb-1">Confirmations</div>
                          <div className="text-muted-foreground">
                            {agent.CurrentTransaction.confirmations ?? '—'}
                          </div>
                        </div>
                        <div>
                          <div className="font-medium mb-1">Fees</div>
                          <div className="text-muted-foreground">
                            {agent.CurrentTransaction.fees
                              ? formatLovelaceToAda(agent.CurrentTransaction.fees)
                              : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="font-medium mb-1">Block time</div>
                          <div className="text-muted-foreground">
                            {agent.CurrentTransaction.blockTime
                              ? formatDate(new Date(agent.CurrentTransaction.blockTime * 1000))
                              : '—'}
                          </div>
                        </div>
                      </div>
                      {agent.CurrentTransaction.txHash && (
                        <div>
                          <div className="font-medium mb-1">Transaction hash</div>
                          <div className="flex items-center gap-2 text-muted-foreground font-mono text-xs break-all">
                            <span>{agent.CurrentTransaction.txHash}</span>
                            <CopyButton value={agent.CurrentTransaction.txHash} />
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>

              <div className="flex justify-between gap-2 pt-4">
                <div className="text-xs text-muted-foreground">
                  {holdingWallet
                    ? `Holding wallet: ${shortenAddress(holdingWallet.walletAddress)}`
                    : ''}
                </div>
                <div className="flex gap-2">
                  {actionLabel && (
                    <Button variant="destructive" onClick={() => setIsDeleteDialogOpen(true)}>
                      {actionLabel}
                    </Button>
                  )}
                  <Button variant="outline" onClick={onClose}>
                    Close
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        title={actionLabel === 'Deregister' ? `Deregister ${agent?.name}` : `Delete ${agent?.name}`}
        description={
          actionLabel === 'Deregister'
            ? `Are you sure you want to deregister "${agent?.name}"? This will burn the managed inbox registry NFT.`
            : `Are you sure you want to delete "${agent?.name}" from the database? This action cannot be undone.`
        }
        onConfirm={() => {
          void handleDeleteOrDeregister();
        }}
        isLoading={isDeleting}
      />

      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
        isChild
      />
    </>
  );
}
