import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, shortenAddress, handleApiCall, formatFundUnit } from '@/lib/utils';
import { WalletLink } from '@/components/ui/wallet-link';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import formatBalance from '@/lib/formatBalance';
import { CopyButton } from '@/components/ui/copy-button';
import { postRegistryDeregister } from '@/lib/api/generated';
import { RegistryEntry, deleteRegistry } from '@/lib/api/generated';

import { Separator } from '@/components/ui/separator';
import { Link2, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { useState, useEffect, useCallback } from 'react';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast } from 'react-toastify';
import { Tabs } from '@/components/ui/tabs';
import { AgentEarningsOverview } from './AgentEarningsOverview';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { extractApiErrorMessage } from '@/lib/api-error';
import { findPaymentSourceWalletByVkey } from '@/lib/wallet-lookup';
import { useMemo } from 'react';
import { VerifyAndPublishAgentDialog } from './VerifyAndPublishAgentDialog';

type AIAgent = RegistryEntry;

interface AIAgentDetailsDialogProps {
  agent: AIAgent | null;
  onClose: () => void;
  onSuccess?: () => void;
  initialTab?: 'Details' | 'Earnings';
}

const parseAgentStatus = (status: AIAgent['state']): string => {
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

const getStatusBadgeVariant = (status: AIAgent['state']) => {
  if (status === 'RegistrationConfirmed') return 'default';
  if (status.includes('Failed')) return 'destructive';
  if (status.includes('Initiated')) return 'secondary';
  if (status.includes('Requested')) return 'secondary';
  if (status === 'DeregistrationConfirmed') return 'secondary';
  return 'secondary';
};

const formatPrice = (amount: string | undefined) => {
  if (!amount) return '—';
  return formatBalance((parseInt(amount) / 1000000).toFixed(2));
};

export function AIAgentDetailsDialog({
  agent,
  onClose,
  onSuccess,
  initialTab = 'Details',
}: AIAgentDetailsDialogProps) {
  const { apiClient, selectedPaymentSourceId, network } = useAppContext();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPurchaseDialogOpen] = useState(false);
  const [isVerifyDialogOpen, setIsVerifyDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab);
  const { paymentSources } = usePaymentSourceExtendedAll();
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );

  // Update activeTab when initialTab changes (when dialog opens with different tab)
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Ensure activeTab is set when dialog opens
  useEffect(() => {
    if (agent && !activeTab) {
      setActiveTab('Details');
    }
  }, [agent, activeTab]);

  const formatDate = (date: Date | string) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateObj.toLocaleDateString();
  };

  const handleDelete = useCallback(async () => {
    if (agent?.state === 'RegistrationFailed' || agent?.state === 'DeregistrationConfirmed') {
      await handleApiCall(
        () =>
          deleteRegistry({
            client: apiClient,
            body: {
              id: agent.id,
            },
          }),
        {
          onSuccess: () => {
            toast.success('AI agent deleted from the database successfully');
            onClose();
            onSuccess?.();
          },
          onError: (error: unknown) => {
            toast.error(extractApiErrorMessage(error, 'Failed to delete AI agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
            setIsDeleteDialogOpen(false);
          },
          errorMessage: 'Failed to delete AI agent',
        },
      );
    } else if (agent?.state === 'RegistrationConfirmed') {
      if (!agent?.agentIdentifier) {
        toast.error('Cannot delete agent: Missing identifier');
        return;
      }

      setIsDeleting(true);
      const selectedPaymentSource = currentNetworkPaymentSources.find(
        (ps) => ps.id === selectedPaymentSourceId,
      );
      if (!selectedPaymentSource) {
        toast.error('Cannot delete agent: Missing payment source');
        return;
      }
      await handleApiCall(
        () =>
          postRegistryDeregister({
            client: apiClient,
            body: {
              agentIdentifier: agent.agentIdentifier!,
              network: network,
              smartContractAddress: selectedPaymentSource.smartContractAddress,
            },
          }),
        {
          onSuccess: () => {
            toast.success('AI agent deregistration initiated successfully');
            onClose();
            onSuccess?.();
          },
          onError: (error: unknown) => {
            toast.error(extractApiErrorMessage(error, 'Failed to deregister AI agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
            setIsDeleteDialogOpen(false);
          },
          errorMessage: 'Failed to deregister AI agent',
        },
      );
    } else {
      toast.error(
        'Cannot delete agent: Agent is not in a deletable state, please wait until pending states have been resolved',
      );
    }
  }, [
    agent?.state,
    agent?.id,
    agent?.agentIdentifier,
    apiClient,
    onClose,
    onSuccess,
    currentNetworkPaymentSources,
    selectedPaymentSourceId,
    network,
  ]);

  const handleWalletClick = useCallback(
    (walletVkey: string) => {
      const found = findPaymentSourceWalletByVkey(currentNetworkPaymentSources, walletVkey);
      if (!found) {
        toast.error('Wallet not found');
        return;
      }
      setSelectedWalletForDetails(found);
    },
    [currentNetworkPaymentSources],
  );

  return (
    <>
      <Dialog open={!!agent && !isDeleteDialogOpen && !isPurchaseDialogOpen} onOpenChange={onClose}>
        <DialogContent
          className="max-w-[600px] max-h-[90vh] px-0 pb-0 flex flex-col"
          isPushedBack={!!selectedWalletForDetails || isVerifyDialogOpen}
        >
          {agent && (
            <>
              <DialogHeader className="px-6 shrink-0">
                <DialogTitle>{agent.name}</DialogTitle>
              </DialogHeader>

              <Tabs
                tabs={[{ name: 'Details' }, { name: 'Earnings' }]}
                activeTab={activeTab || 'Details'}
                onTabChange={(tabName) => setActiveTab(tabName as 'Details' | 'Earnings')}
                className="px-6 shrink-0"
              />

              <div className="space-y-6 py-4 px-6 overflow-y-auto min-h-0 flex-1">
                {activeTab === 'Details' && (
                  <>
                    {/* Status and Description */}
                    <div className="flex items-start justify-between w-full gap-4">
                      <div className="w-full truncate">
                        <h3 className="font-medium mb-2">Description</h3>
                        <p className="text-sm text-muted-foreground truncate">
                          {agent.description || 'No description provided'}
                        </p>
                      </div>
                      <Badge
                        variant={getStatusBadgeVariant(agent.state)}
                        className={cn(
                          agent.state === 'RegistrationConfirmed' &&
                            'bg-green-50 text-green-700 hover:bg-green-50/80',
                          'w-fit min-w-fit truncate',
                        )}
                      >
                        {parseAgentStatus(agent.state)}
                      </Badge>
                    </div>

                    {/* Error Message */}
                    {(agent.state === 'RegistrationFailed' ||
                      agent.state === 'DeregistrationFailed') &&
                      agent.error && (
                        <Card className="border-destructive bg-destructive/10">
                          <CardHeader>
                            <CardTitle className="text-sm font-medium text-destructive">
                              Error Details
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="text-sm text-destructive whitespace-pre-wrap">
                              {agent.error}
                            </p>
                          </CardContent>
                        </Card>
                      )}

                    {/* API Base URL */}
                    {agent.apiBaseUrl && (
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm font-medium">API Base URL</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="flex items-center justify-between py-2 gap-2 bg-muted/40 p-2 rounded-lg border">
                            <span className="text-sm text-muted-foreground">Endpoint</span>
                            <div className="font-mono text-sm flex items-center gap-2 truncate">
                              <a
                                href={agent.apiBaseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline text-primary truncate"
                              >
                                {agent.apiBaseUrl}
                              </a>
                              <CopyButton value={agent.apiBaseUrl} />
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {/* Tags */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-medium">Tags</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-wrap gap-2">
                          {agent.Tags && agent.Tags.length > 0 ? (
                            agent.Tags.map((tag, index) => (
                              <Badge key={index} variant="secondary">
                                {tag}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-sm text-muted-foreground">No tags</span>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Pricing */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-medium">Pricing Details</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2 p-2 bg-muted/40 border rounded-md">
                          {agent.AgentPricing?.pricingType == 'Free' && (
                            <div className="text-sm text-muted-foreground">
                              <span className="font-medium">Free</span>
                            </div>
                          )}
                          {agent.AgentPricing?.pricingType == 'Dynamic' && (
                            <div className="text-sm text-muted-foreground">
                              <span className="font-medium">Dynamic</span>
                              <span className="ml-1 text-xs">(price set per request)</span>
                            </div>
                          )}
                          {agent.AgentPricing &&
                            agent.AgentPricing?.pricingType == 'Fixed' &&
                            agent.AgentPricing?.Pricing?.map((price, index, arr) => (
                              <div
                                key={index}
                                className={cn(
                                  'flex items-center justify-between py-2',
                                  index < arr.length - 1 && 'border-b',
                                )}
                              >
                                <span className="text-sm text-muted-foreground">
                                  Price ({formatFundUnit(price.unit, network)})
                                </span>
                                <span className="font-medium">
                                  {`${formatPrice(price.amount)} ${formatFundUnit(price.unit, network)}`}
                                </span>
                              </div>
                            ))}
                          {(!agent.AgentPricing ||
                            (agent.AgentPricing.pricingType == 'Fixed' &&
                              agent.AgentPricing.Pricing.length === 0)) && (
                            <div className="text-sm text-muted-foreground">
                              No pricing information available
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    <div className="flex items-center gap-4 pt-2">
                      <Separator className="flex-1" />
                      <h3 className="text-sm font-medium text-muted-foreground whitespace-nowrap">
                        Additional Details
                      </h3>
                      <Separator className="flex-1" />
                    </div>

                    {/* Author and Legal */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      <div>
                        <h3 className="font-medium mb-4">Author</h3>
                        <div className="space-y-3 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Name:</span>
                            <span>{agent.Author.name}</span>
                          </div>
                          {agent.Author.contactEmail && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Email:</span>
                              <a
                                href={`mailto:${agent.Author.contactEmail}`}
                                className="text-primary hover:underline"
                              >
                                {agent.Author.contactEmail}
                              </a>
                            </div>
                          )}
                          {agent.Author.organization && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Organization:</span>
                              <span>{agent.Author.organization}</span>
                            </div>
                          )}
                          {agent.Author.contactOther && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Website:</span>
                              <a
                                href={agent.Author.contactOther}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline flex items-center gap-1"
                              >
                                {agent.Author.contactOther} <Link2 className="h-3 w-3" />
                              </a>
                            </div>
                          )}
                        </div>
                      </div>
                      <div>
                        <h3 className="font-medium mb-4">Legal</h3>
                        <div className="space-y-3 text-sm">
                          {agent.Legal?.terms && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Terms of Use:</span>
                              <a
                                href={agent.Legal.terms}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline flex items-center gap-1"
                              >
                                View Link <Link2 className="h-3 w-3" />
                              </a>
                            </div>
                          )}
                          {agent.Legal?.privacyPolicy && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Privacy Policy:</span>
                              <a
                                href={agent.Legal.privacyPolicy}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline flex items-center gap-1"
                              >
                                View Link <Link2 className="h-3 w-3" />
                              </a>
                            </div>
                          )}
                          {agent.Legal?.other && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Support:</span>
                              <a
                                href={agent.Legal.other}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline flex items-center gap-1"
                              >
                                View Link <Link2 className="h-3 w-3" />
                              </a>
                            </div>
                          )}
                          {(!agent.Legal || Object.values(agent.Legal).every((v) => !v)) && (
                            <span className="text-muted-foreground">
                              No legal information provided.
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Capability */}
                    {agent.Capability && (agent.Capability.name || agent.Capability.version) && (
                      <div>
                        <h3 className="font-medium mb-2">Capability</h3>
                        <div className="flex justify-between text-sm p-3 bg-muted/40 rounded-md">
                          <span className="text-muted-foreground">Model:</span>
                          <span>
                            {agent.Capability.name} (v
                            {agent.Capability.version})
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Example Outputs */}
                    {agent.ExampleOutputs && agent.ExampleOutputs.length > 0 && (
                      <div>
                        <h3 className="font-medium mb-2">Example Outputs</h3>
                        <div className="space-y-2">
                          {agent.ExampleOutputs.map((output, index) => (
                            <div key={index} className="text-sm p-3 bg-muted/40 rounded-md">
                              <div className="flex justify-between items-center">
                                <div>
                                  <p className="font-semibold">{output.name}</p>
                                  <p className="text-xs text-muted-foreground">{output.mimeType}</p>
                                </div>
                                <a
                                  href={output.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline flex items-center gap-1"
                                >
                                  View <Link2 className="h-3 w-3" />
                                </a>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Wallet Information */}
                    <div>
                      <h3 className="font-medium mb-2">Wallet Information</h3>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between py-2 border-b">
                          <span className="text-sm text-muted-foreground">Agent Identifier</span>
                          <div className="font-mono text-sm flex items-center gap-2">
                            {shortenAddress(agent.agentIdentifier || '')}
                            <CopyButton value={agent.agentIdentifier || ''} />
                          </div>
                        </div>
                        <div className="flex items-center justify-between py-2">
                          <span className="text-sm text-muted-foreground">
                            Minting Wallet Address
                          </span>
                          <WalletLink
                            address={agent.SmartContractWallet.walletAddress}
                            vkey={agent.SmartContractWallet.walletVkey}
                            network={network}
                            shorten={4}
                            onInternalClick={() =>
                              handleWalletClick(agent.SmartContractWallet.walletVkey)
                            }
                          />
                        </div>
                        {agent.RecipientWallet && (
                          <div className="flex items-center justify-between py-2 border-t">
                            <span className="text-sm text-muted-foreground">
                              Recipient Wallet Address
                            </span>
                            <WalletLink
                              address={agent.RecipientWallet.walletAddress}
                              vkey={agent.RecipientWallet.walletVkey}
                              network={network}
                              shorten={4}
                              onInternalClick={() =>
                                handleWalletClick(agent.RecipientWallet!.walletVkey)
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Timestamps */}
                    <div>
                      <h3 className="font-medium mb-2">Timestamps</h3>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between py-2 border-b">
                          <span className="text-sm text-muted-foreground">Registered On</span>
                          <span className="font-mono text-sm">{formatDate(agent.createdAt)}</span>
                        </div>
                        <div className="flex items-center justify-between py-2">
                          <span className="text-sm text-muted-foreground">Last Updated</span>
                          <span className="font-mono text-sm">{formatDate(agent.updatedAt)}</span>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {activeTab === 'Earnings' && (
                  <AgentEarningsOverview
                    agentIdentifier={agent.agentIdentifier || ''}
                    agentName={agent.name}
                  />
                )}
              </div>

              <div className="py-4 px-4 border-t flex justify-end gap-2 bg-background shrink-0">
                {agent?.state === 'RegistrationConfirmed' && agent.agentIdentifier && (
                  <Button variant="outline" onClick={() => setIsVerifyDialogOpen(true)}>
                    <ShieldCheck className="h-4 w-4" />
                    Verify & Publish
                  </Button>
                )}
                <Button variant="destructive" onClick={() => setIsDeleteDialogOpen(true)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        title={
          agent?.state === 'RegistrationConfirmed'
            ? `Deregister ${agent?.name}?`
            : `Delete ${agent?.name}?`
        }
        description={
          agent?.state === 'RegistrationConfirmed'
            ? `Are you sure you want to deregister "${agent?.name}"? This action cannot be undone.`
            : `Are you sure you want to delete "${agent?.name}"? This action cannot be undone.`
        }
        onConfirm={handleDelete}
        isLoading={isDeleting}
      />
      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
        isChild
      />
      <VerifyAndPublishAgentDialog
        agent={agent}
        open={isVerifyDialogOpen}
        onClose={() => setIsVerifyDialogOpen(false)}
      />
    </>
  );
}
