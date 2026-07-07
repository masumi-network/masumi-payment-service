import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/format-date';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { shortenAddress } from '@/lib/utils';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { Spinner } from '@/components/ui/spinner';
import { WalletLink } from '@/components/ui/wallet-link';
import type { PaymentSourceExtended } from '@/lib/api/generated';
import { usePaymentSourceWalletList } from '@/lib/queries/useWallets';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { getPaymentSourceTypeLabel, isV2PaymentSource } from '@/lib/payment-source-type';

interface PaymentSourceDialogProps {
  open: boolean;
  onClose: () => void;
  paymentSource: PaymentSourceExtended | null;
}

export function PaymentSourceDialog({ open, onClose, paymentSource }: PaymentSourceDialogProps) {
  const { network } = useAppContext();
  const [expandedSections, setExpandedSections] = useState<{
    [key: string]: boolean;
  }>({
    admin: true,
    purchasing: false,
    selling: false,
    fee: false,
  });

  // Hot wallets are fetched lazily (and paginated) per section via the
  // dedicated /wallet/list endpoint rather than embedded in the payment source.
  const purchasingWallets = usePaymentSourceWalletList({
    paymentSourceId: paymentSource?.id ?? null,
    walletType: 'Purchasing',
    enabled: open && expandedSections.purchasing,
  });
  const sellingWallets = usePaymentSourceWalletList({
    paymentSourceId: paymentSource?.id ?? null,
    walletType: 'Selling',
    enabled: open && expandedSections.selling,
  });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  if (!paymentSource) return null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Payment Source Details
            <PaymentSourceTypeBadge
              paymentSourceType={paymentSource.paymentSourceType}
              showDefault
            />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Basic Information</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Network</label>
                <div className="text-sm">{paymentSource.network}</div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">
                  Payment Source Type
                </label>
                <div className="text-sm">
                  {getPaymentSourceTypeLabel(paymentSource.paymentSourceType)}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Fee rate (%)</label>
                <div className="text-sm">
                  {(paymentSource.feeRatePermille / 10).toFixed(1)}%
                  {isV2PaymentSource(paymentSource) && (
                    <span className="ml-1 text-xs text-muted-foreground">fixed</span>
                  )}
                </div>
              </div>
              {isV2PaymentSource(paymentSource) && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">
                    Required Admin Signatures
                  </label>
                  <div className="text-sm">{paymentSource.requiredAdminSignatures ?? 2} of 3</div>
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Policy ID</label>
                <div className="text-sm font-mono">
                  {paymentSource.policyId ? shortenAddress(paymentSource.policyId, 10) : 'None'}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Created At</label>
                <div className="text-sm">{formatDateTime(paymentSource.createdAt)}</div>
              </div>
            </div>
          </div>

          {/* Contract Address */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">
              Smart Contract Address
            </label>
            <div className="p-3 bg-muted rounded-md">
              <WalletLink address={paymentSource.smartContractAddress} network={network} />
            </div>
          </div>

          {/* Admin Wallets Section */}
          <div className="space-y-3">
            <button
              onClick={() => toggleSection('admin')}
              className="flex items-center justify-between w-full p-3 bg-muted rounded-md hover:bg-muted/80 transition-colors"
            >
              <h4 className="font-medium">
                Admin Wallets ({paymentSource.AdminWallets?.length || 0})
              </h4>
              {expandedSections.admin ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {expandedSections.admin && (
              <div className="space-y-3 pl-4">
                {paymentSource.AdminWallets?.map((wallet, index) => (
                  <div key={index} className="p-3 border rounded-md space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Admin Wallet {index + 1}</span>
                      {/* AdminWallet generated type has no `note` field
                          (unlike Purchasing/Selling); the API doesn't
                          return one for admin wallets. */}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Address:</span>
                      <WalletLink address={wallet.walletAddress} network={network} shorten={10} />
                    </div>
                  </div>
                ))}
                {(!paymentSource.AdminWallets || paymentSource.AdminWallets.length === 0) && (
                  <div className="text-sm text-muted-foreground">No admin wallets found</div>
                )}
              </div>
            )}
          </div>

          {/* Purchasing Wallets Section */}
          <div className="space-y-3">
            <button
              onClick={() => toggleSection('purchasing')}
              className="flex items-center justify-between w-full p-3 bg-muted rounded-md hover:bg-muted/80 transition-colors"
            >
              <h4 className="font-medium">
                Purchasing Wallets ({paymentSource.PurchasingWalletsCount})
              </h4>
              {expandedSections.purchasing ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {expandedSections.purchasing && (
              <div className="space-y-3 pl-4">
                {purchasingWallets.wallets.map((wallet, index) => (
                  <div key={wallet.id} className="p-3 border rounded-md space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Purchasing Wallet {index + 1}</span>
                      {wallet.note && (
                        <Badge variant="secondary" className="text-xs">
                          {wallet.note}
                        </Badge>
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Address:</span>
                        <WalletLink address={wallet.walletAddress} network={network} shorten={10} />
                      </div>
                      {wallet.collectionAddress && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Collection:</span>
                          <WalletLink
                            address={wallet.collectionAddress}
                            network={network}
                            shorten={10}
                          />
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Verification Key:</span>
                        <span className="text-sm font-mono flex-1">
                          {shortenAddress(wallet.walletVkey, 10)}
                        </span>
                        <CopyButton value={wallet.walletVkey} />
                      </div>
                    </div>
                  </div>
                ))}
                {purchasingWallets.isLoading ? (
                  <div className="flex justify-center py-3">
                    <Spinner size={16} />
                  </div>
                ) : (
                  purchasingWallets.wallets.length === 0 && (
                    <div className="text-sm text-muted-foreground">No purchasing wallets found</div>
                  )
                )}
                {purchasingWallets.hasMore && (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={purchasingWallets.loadMore}
                      disabled={purchasingWallets.isFetchingNextPage}
                    >
                      {purchasingWallets.isFetchingNextPage ? 'Loading…' : 'Load more'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Selling Wallets Section */}
          <div className="space-y-3">
            <button
              onClick={() => toggleSection('selling')}
              className="flex items-center justify-between w-full p-3 bg-muted rounded-md hover:bg-muted/80 transition-colors"
            >
              <h4 className="font-medium">Selling Wallets ({paymentSource.SellingWalletsCount})</h4>
              {expandedSections.selling ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {expandedSections.selling && (
              <div className="space-y-3 pl-4">
                {sellingWallets.wallets.map((wallet, index) => (
                  <div key={wallet.id} className="p-3 border rounded-md space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Selling Wallet {index + 1}</span>
                      {wallet.note && (
                        <Badge variant="secondary" className="text-xs">
                          {wallet.note}
                        </Badge>
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Address:</span>
                        <WalletLink address={wallet.walletAddress} network={network} shorten={10} />
                      </div>
                      {wallet.collectionAddress && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Collection:</span>
                          <WalletLink
                            address={wallet.collectionAddress}
                            network={network}
                            shorten={10}
                          />
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Verification Key:</span>
                        <span className="text-sm font-mono flex-1">
                          {shortenAddress(wallet.walletVkey, 10)}
                        </span>
                        <CopyButton value={wallet.walletVkey} />
                      </div>
                    </div>
                  </div>
                ))}
                {sellingWallets.isLoading ? (
                  <div className="flex justify-center py-3">
                    <Spinner size={16} />
                  </div>
                ) : (
                  sellingWallets.wallets.length === 0 && (
                    <div className="text-sm text-muted-foreground">No selling wallets found</div>
                  )
                )}
                {sellingWallets.hasMore && (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={sellingWallets.loadMore}
                      disabled={sellingWallets.isFetchingNextPage}
                    >
                      {sellingWallets.isFetchingNextPage ? 'Loading…' : 'Load more'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Fee Receiver Section */}
          <div className="space-y-3">
            <button
              onClick={() => toggleSection('fee')}
              className="flex items-center justify-between w-full p-3 bg-muted rounded-md hover:bg-muted/80 transition-colors"
            >
              <h4 className="font-medium">Fee Receiver Wallet</h4>
              {expandedSections.fee ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {expandedSections.fee && (
              <div className="space-y-3 pl-4">
                {paymentSource.FeeReceiverNetworkWallet ? (
                  <div className="p-3 border rounded-md space-y-2">
                    <WalletLink
                      address={paymentSource.FeeReceiverNetworkWallet.walletAddress}
                      network={network}
                      shorten={10}
                    />
                  </div>
                ) : isV2PaymentSource(paymentSource) ? (
                  <div className="text-sm text-muted-foreground">
                    V2 sources are zero-fee and do not need a fee receiver wallet.
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No fee receiver wallet found</div>
                )}
              </div>
            )}
          </div>

          {/* Configuration */}
          {paymentSource.PaymentSourceConfig && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Configuration</h3>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">RPC Provider</label>
                <div className="text-sm">{paymentSource.PaymentSourceConfig.rpcProvider}</div>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
