import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  cn,
  shortenAddress,
  handleApiCall,
  formatFundUnit,
  formatAssetAmount,
  getExplorerUrl,
} from '@/lib/utils';
import { WalletLink } from '@/components/ui/wallet-link';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { postRegistryDeregister } from '@/lib/api/generated';
import { RegistryEntry, deleteRegistry } from '@/lib/api/generated';
import { parseAgentStatus, getAgentStatusBadgeVariant } from '@/lib/agent-status';
import { isDbDeletableAgentState, isDeregisterableAgentState } from '@/lib/registry-states';
import type { AgentRelation } from '@/lib/queries/useContextAgents';

import { Separator } from '@/components/ui/separator';
import { Link2, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { RegisterAIAgentDialog } from './RegisterAIAgentDialog';
import { useState, useEffect, useCallback, useRef } from 'react';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast } from 'react-toastify';
import { Tabs } from '@/components/ui/tabs';
import { AgentEarningsOverview } from './AgentEarningsOverview';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { extractApiErrorMessage } from '@/lib/api-error';
import { lookupWalletByVkey } from '@/lib/wallet-lookup';
import { useMemo } from 'react';
import { VerifyAndPublishAgentDialog } from './VerifyAndPublishAgentDialog';
import { AgentX402Options } from './AgentX402Options';
import { AgentCardanoSources } from './AgentCardanoSources';
import { AgentVerifications } from './AgentVerifications';

// The list page decorates agents with their relation to the active payment
// source ('payment' = registered elsewhere, merely accepts payment here).
// Optional because lookups that don't compute it (deep links, transaction
// dialogs) are already scoped to the active source and default to managed.
type AIAgent = RegistryEntry & { relation?: AgentRelation };

interface AIAgentDetailsDialogProps {
  agent: AIAgent | null;
  elevatedStack?: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  initialTab?: 'Details' | 'Earnings';
}

export function AIAgentDetailsDialog({
  agent,
  elevatedStack,
  onClose,
  onSuccess,
  initialTab = 'Details',
}: AIAgentDetailsDialogProps) {
  const { apiClient, selectedPaymentSourceId, network } = useAppContext();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPurchaseDialogOpen] = useState(false);
  const [isVerifyDialogOpen, setIsVerifyDialogOpen] = useState(false);
  // Re-register (deregistered agents only): confirm the new-identifier caveat,
  // then open the mint dialog prefilled from this agent.
  const [isReRegisterConfirmOpen, setIsReRegisterConfirmOpen] = useState(false);
  const [isReRegisterOpen, setIsReRegisterOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab);
  const { paymentSources } = usePaymentSourceExtendedAll();
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  // vkey of the wallet whose details lookup is currently in flight (drives the
  // per-row spinner so a slow lookup gives immediate click feedback).
  const [loadingWalletVkey, setLoadingWalletVkey] = useState<string | null>(null);
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

  // Manage actions (deregister/verify) only apply to agents registered on the
  // active payment source; agents shown because they merely accept payment
  // here ('payment' relation) are managed from their home source — mirrors the
  // row-action gating on pages/ai-agents.tsx.
  const isManagedOnActiveSource = agent?.relation !== 'payment';

  // Reset the tab whenever the dialog opens (or opens for a different agent):
  // without keying on the agent id, the previous agent's tab (e.g. Earnings,
  // which fires its fetch on mount) would bleed into the next open.
  const agentId = agent?.id;
  useEffect(() => {
    if (agentId) {
      setActiveTab(initialTab);
      // Never carry a half-open re-register flow from one agent into the next.
      setIsReRegisterConfirmOpen(false);
      setIsReRegisterOpen(false);
    }
  }, [agentId, initialTab]);

  // Re-registration mints a fresh asset, so it only makes sense for an agent
  // with no live on-chain registration — either deregistered (the old asset was
  // burned) or a registration that never completed (RegistrationFailed) — and
  // that is managed on the active payment source (the mint targets the active
  // source).
  const canReRegister =
    (agent?.state === 'DeregistrationConfirmed' || agent?.state === 'RegistrationFailed') &&
    isManagedOnActiveSource;

  const formatDate = (date: Date | string) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateObj.toLocaleDateString();
  };

  // Synchronous in-flight guard for delete/deregister: `setIsDeleting(true)`
  // is async, so a fast double-click on Confirm fires `handleDelete` twice
  // before the button disables — sending two requests for the same agent. The
  // ref flips synchronously so the duplicate is rejected immediately.
  const isDeletingRef = useRef(false);

  const handleDelete = useCallback(async () => {
    if (!agent) return;
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    try {
      if (isDbDeletableAgentState(agent.state)) {
        setIsDeleting(true);
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
      } else if (isDeregisterableAgentState(agent.state)) {
        if (!agent.agentIdentifier) {
          toast.error('Cannot delete agent: Missing identifier');
          return;
        }
        const selectedPaymentSource = currentNetworkPaymentSources.find(
          (ps) => ps.id === selectedPaymentSourceId,
        );
        if (!selectedPaymentSource) {
          toast.error('Cannot delete agent: Missing payment source');
          return;
        }
        // Only set after every early-return guard above — bailing out with
        // isDeleting stuck true would disable both dialog buttons forever.
        setIsDeleting(true);
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
    } finally {
      isDeletingRef.current = false;
    }
  }, [
    agent,
    apiClient,
    onClose,
    onSuccess,
    currentNetworkPaymentSources,
    selectedPaymentSourceId,
    network,
  ]);

  const handleWalletClick = useCallback(
    async (walletVkey: string) => {
      // Guard against a second click while a lookup is already resolving.
      if (loadingWalletVkey) return;
      setLoadingWalletVkey(walletVkey);
      try {
        const found = await lookupWalletByVkey({ apiClient, walletVkey });
        if (!found) {
          toast.error('Wallet not found');
          return;
        }
        setSelectedWalletForDetails(found);
      } finally {
        setLoadingWalletVkey(null);
      }
    },
    [apiClient, loadingWalletVkey],
  );

  return (
    <>
      <Dialog
        open={
          !!agent &&
          !isDeleteDialogOpen &&
          !isPurchaseDialogOpen &&
          !isReRegisterConfirmOpen &&
          !isReRegisterOpen
        }
        onOpenChange={onClose}
      >
        <DialogContent
          className="max-w-[600px] max-h-[90vh] px-0 pb-0 flex flex-col"
          elevatedStack={elevatedStack}
          isPushedBack={!!selectedWalletForDetails || isVerifyDialogOpen}
        >
          {agent && (
            <>
              <DialogHeader className="px-6 shrink-0">
                <div className="flex items-start justify-between gap-3 pr-6">
                  <DialogTitle className="text-xl leading-tight break-words">
                    {agent.name}
                  </DialogTitle>
                  <Badge
                    variant={getAgentStatusBadgeVariant(agent.state)}
                    className="mt-0.5 shrink-0 whitespace-nowrap"
                  >
                    {parseAgentStatus(agent.state)}
                  </Badge>
                </div>
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
                    {/* Description */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-medium">Description</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
                          {agent.description || 'No description provided'}
                        </p>
                      </CardContent>
                    </Card>

                    {/* Error Message */}
                    {(agent.state === 'RegistrationFailed' ||
                      agent.state === 'DeregistrationFailed' ||
                      agent.state === 'UpdateFailed') &&
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
                                  {formatAssetAmount(price.amount, price.unit, network)}
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

                    <AgentCardanoSources sources={agent.supportedPaymentSources} />

                    <AgentX402Options sources={agent.supportedPaymentSources} />

                    <AgentVerifications verifications={agent.verifications} />

                    <div className="flex items-center gap-4 pt-2">
                      <Separator className="flex-1" />
                      <h3 className="text-sm font-medium text-muted-foreground whitespace-nowrap">
                        Additional Details
                      </h3>
                      <Separator className="flex-1" />
                    </div>

                    {/* Author and Legal */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm font-medium">Author</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3 text-sm">
                            <div className="flex justify-between gap-3">
                              <span className="text-muted-foreground shrink-0">Name</span>
                              <span className="text-right break-words">{agent.Author.name}</span>
                            </div>
                            {agent.Author.contactEmail && (
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground shrink-0">Email</span>
                                <a
                                  href={`mailto:${agent.Author.contactEmail}`}
                                  className="text-primary hover:underline text-right break-all"
                                >
                                  {agent.Author.contactEmail}
                                </a>
                              </div>
                            )}
                            {agent.Author.organization && (
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground shrink-0">Organization</span>
                                <span className="text-right break-words">
                                  {agent.Author.organization}
                                </span>
                              </div>
                            )}
                            {agent.Author.contactOther && (
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground shrink-0">Website</span>
                                <a
                                  href={agent.Author.contactOther}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline flex items-center gap-1 text-right break-all"
                                >
                                  {agent.Author.contactOther} <Link2 className="h-3 w-3 shrink-0" />
                                </a>
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm font-medium">Legal</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3 text-sm">
                            {agent.Legal?.terms && (
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground shrink-0">Terms of Use</span>
                                <a
                                  href={agent.Legal.terms}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline flex items-center gap-1"
                                >
                                  View Link <Link2 className="h-3 w-3 shrink-0" />
                                </a>
                              </div>
                            )}
                            {agent.Legal?.privacyPolicy && (
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground shrink-0">
                                  Privacy Policy
                                </span>
                                <a
                                  href={agent.Legal.privacyPolicy}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline flex items-center gap-1"
                                >
                                  View Link <Link2 className="h-3 w-3 shrink-0" />
                                </a>
                              </div>
                            )}
                            {agent.Legal?.other && (
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground shrink-0">Support</span>
                                <a
                                  href={agent.Legal.other}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline flex items-center gap-1"
                                >
                                  View Link <Link2 className="h-3 w-3 shrink-0" />
                                </a>
                              </div>
                            )}
                            {(!agent.Legal || Object.values(agent.Legal).every((v) => !v)) && (
                              <span className="text-muted-foreground">
                                No legal information provided.
                              </span>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Capability */}
                    {agent.Capability && (agent.Capability.name || agent.Capability.version) && (
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm font-medium">Capability</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="flex justify-between text-sm py-2 px-3 bg-muted/40 border rounded-md">
                            <span className="text-muted-foreground">Model</span>
                            <span>
                              {agent.Capability.name} (v
                              {agent.Capability.version})
                            </span>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {/* Example Outputs */}
                    {agent.ExampleOutputs && agent.ExampleOutputs.length > 0 && (
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm font-medium">Example Outputs</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-2">
                            {agent.ExampleOutputs.map((output, index) => (
                              <div
                                key={index}
                                className="text-sm py-2 px-3 bg-muted/40 border rounded-md"
                              >
                                <div className="flex justify-between items-center gap-3">
                                  <div className="min-w-0">
                                    <p className="font-medium truncate">{output.name}</p>
                                    <p className="text-xs text-muted-foreground truncate">
                                      {output.mimeType}
                                    </p>
                                  </div>
                                  <a
                                    href={output.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline flex items-center gap-1 shrink-0"
                                  >
                                    View <Link2 className="h-3 w-3" />
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {/* Wallet Information */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-medium">Wallet Information</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="px-3 bg-muted/40 border rounded-md">
                          <div className="flex items-center justify-between py-2.5 border-b">
                            <span className="text-sm text-muted-foreground">Agent Identifier</span>
                            <div className="font-mono text-sm flex items-center gap-2">
                              {agent.agentIdentifier ? (
                                <>
                                  <a
                                    href={getExplorerUrl(agent.agentIdentifier, network, 'token')}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline flex items-center gap-1"
                                  >
                                    {shortenAddress(agent.agentIdentifier)}
                                    <Link2 className="h-3 w-3" />
                                  </a>
                                  <CopyButton value={agent.agentIdentifier} />
                                </>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </div>
                          </div>
                          {usesCombinedWallet && holdingWallet ? (
                            <div className="flex items-center justify-between py-2.5">
                              <span className="text-sm text-muted-foreground">
                                Minting & Holding Wallet
                              </span>
                              <WalletLink
                                address={holdingWallet.walletAddress}
                                vkey={holdingWallet.walletVkey}
                                network={network}
                                shorten={4}
                                isLoading={loadingWalletVkey === holdingWallet.walletVkey}
                                onInternalClick={() => handleWalletClick(holdingWallet.walletVkey)}
                              />
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center justify-between py-2.5">
                                <span className="text-sm text-muted-foreground">
                                  Minting Wallet
                                </span>
                                <WalletLink
                                  address={agent.SmartContractWallet.walletAddress}
                                  vkey={agent.SmartContractWallet.walletVkey}
                                  network={network}
                                  shorten={4}
                                  isLoading={
                                    loadingWalletVkey === agent.SmartContractWallet.walletVkey
                                  }
                                  onInternalClick={() =>
                                    handleWalletClick(agent.SmartContractWallet.walletVkey)
                                  }
                                />
                              </div>
                              {holdingWallet && (
                                <div className="flex items-center justify-between py-2.5 border-t">
                                  <span className="text-sm text-muted-foreground">
                                    Holding Wallet
                                  </span>
                                  <WalletLink
                                    address={holdingWallet.walletAddress}
                                    vkey={holdingWallet.walletVkey}
                                    network={network}
                                    shorten={4}
                                    isLoading={loadingWalletVkey === holdingWallet.walletVkey}
                                    onInternalClick={() =>
                                      handleWalletClick(holdingWallet.walletVkey)
                                    }
                                  />
                                </div>
                              )}
                            </>
                          )}
                          {agent.sendFundingLovelace && (
                            <div className="flex items-center justify-between py-2.5 border-t">
                              <span className="text-sm text-muted-foreground">
                                Holding Wallet Funding Override
                              </span>
                              <span className="font-mono text-sm">
                                {formatAssetAmount(agent.sendFundingLovelace, 'lovelace', network)}
                              </span>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Timestamps */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-medium">Timestamps</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="px-3 bg-muted/40 border rounded-md">
                          <div className="flex items-center justify-between py-2.5 border-b">
                            <span className="text-sm text-muted-foreground">Registered On</span>
                            <span className="font-mono text-sm">{formatDate(agent.createdAt)}</span>
                          </div>
                          <div className="flex items-center justify-between py-2.5">
                            <span className="text-sm text-muted-foreground">Last Updated</span>
                            <span className="font-mono text-sm">{formatDate(agent.updatedAt)}</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
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
                {canReRegister && (
                  <Button variant="outline" onClick={() => setIsReRegisterConfirmOpen(true)}>
                    <RotateCcw className="h-4 w-4" />
                    Re-register
                  </Button>
                )}
                {isManagedOnActiveSource &&
                  (agent.state === 'RegistrationConfirmed' ||
                    agent.state === 'UpdateConfirmed' ||
                    agent.state === 'UpdateFailed') &&
                  agent.agentIdentifier && (
                    <Button variant="outline" onClick={() => setIsVerifyDialogOpen(true)}>
                      <ShieldCheck className="h-4 w-4" />
                      Verify & Publish
                    </Button>
                  )}
                {isManagedOnActiveSource && (
                  <Button variant="destructive" onClick={() => setIsDeleteDialogOpen(true)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        elevatedChildStack={elevatedStack}
        title={
          isDeregisterableAgentState(agent?.state)
            ? `Deregister ${agent?.name}?`
            : `Delete ${agent?.name}?`
        }
        description={
          isDeregisterableAgentState(agent?.state)
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
        elevatedChildStack={elevatedStack}
      />
      <VerifyAndPublishAgentDialog
        agent={agent}
        open={isVerifyDialogOpen}
        onClose={() => setIsVerifyDialogOpen(false)}
        elevatedChildStack={elevatedStack}
      />
      <ConfirmDialog
        open={isReRegisterConfirmOpen}
        onClose={() => setIsReRegisterConfirmOpen(false)}
        elevatedChildStack={elevatedStack}
        title={`Re-register ${agent?.name}?`}
        description={
          agent?.state === 'RegistrationFailed'
            ? 'This retries registration as a brand-new mint and issues a NEW agent identifier ' +
              '(the failed attempt never minted one). Review and edit all details below, then mint.'
            : 'This mints a brand-new registration and issues a NEW agent identifier. ' +
              'The previous, deregistered identifier is permanent and cannot be reused, so ' +
              'anything referencing the old identifier will need to be updated. You can review ' +
              'and edit all details before minting.'
        }
        onConfirm={() => {
          setIsReRegisterConfirmOpen(false);
          setIsReRegisterOpen(true);
        }}
      />
      <RegisterAIAgentDialog
        open={isReRegisterOpen && !!agent}
        prefillAgent={agent}
        elevatedChildStack={elevatedStack}
        onClose={() => setIsReRegisterOpen(false)}
        onSuccess={() => {
          setIsReRegisterOpen(false);
          onClose();
          onSuccess?.();
        }}
      />
    </>
  );
}
