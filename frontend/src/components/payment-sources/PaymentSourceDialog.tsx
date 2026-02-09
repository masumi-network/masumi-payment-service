import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { shortenAddress, getExplorerUrl } from '@/lib/utils';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';

interface PaymentSourceDialogProps {
  open: boolean;
  onClose: () => void;
  paymentSource: any;
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
          <DialogTitle>Payment Source Details</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Basic Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Network</label>
                <div className="text-sm">{paymentSource.network}</div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Fee rate (%)</label>
                <div className="text-sm">{(paymentSource.feeRatePermille / 10).toFixed(1)}%</div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Created At</label>
                <div className="text-sm">{new Date(paymentSource.createdAt).toLocaleString()}</div>
              </div>
            </div>
          </div>

          {/* Contract Address */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">
              Smart Contract Address
            </label>
            <div className="flex items-center gap-2 p-3 bg-muted rounded-md">
              <a
                href={getExplorerUrl(paymentSource.smartContractAddress, network)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono flex-1 hover:underline text-primary"
              >
                {paymentSource.smartContractAddress}
              </a>
              <CopyButton value={paymentSource.smartContractAddress} />
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
                {paymentSource.AdminWallets?.map((wallet: any, index: number) => (
                  <div key={index} className="p-3 border rounded-md space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Admin Wallet {index + 1}</span>
                      {wallet.note && (
                        <Badge variant="secondary" className="text-xs">
                          {wallet.note}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono flex-1">
                        Address:{' '}
                        <a
                          href={getExplorerUrl(wallet.walletAddress, network)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline text-primary"
                        >
                          {shortenAddress(wallet.walletAddress, 10)}
                        </a>
                      </span>
                      <CopyButton value={wallet.walletAddress} />
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
                Purchasing Wallets ({paymentSource.PurchasingWallets?.length || 0})
              </h4>
              {expandedSections.purchasing ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {expandedSections.purchasing && (
              <div className="space-y-3 pl-4">
                {paymentSource.PurchasingWallets?.map((wallet: any, index: number) => (
                  <div key={index} className="p-3 border rounded-md space-y-2">
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
                        <a
                          href={getExplorerUrl(wallet.walletAddress, network)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-mono flex-1 hover:underline text-primary"
                        >
                          {shortenAddress(wallet.walletAddress, 10)}
                        </a>
                        <CopyButton value={wallet.walletAddress} />
                      </div>
                      {wallet.collectionAddress && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Collection:</span>
                          <a
                            href={getExplorerUrl(wallet.collectionAddress, network)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-mono flex-1 hover:underline text-primary"
                          >
                            {shortenAddress(wallet.collectionAddress, 10)}
                          </a>
                          <CopyButton value={wallet.collectionAddress} />
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
                {(!paymentSource.PurchasingWallets ||
                  paymentSource.PurchasingWallets.length === 0) && (
                  <div className="text-sm text-muted-foreground">No purchasing wallets found</div>
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
              <h4 className="font-medium">
                Selling Wallets ({paymentSource.SellingWallets?.length || 0})
              </h4>
              {expandedSections.selling ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {expandedSections.selling && (
              <div className="space-y-3 pl-4">
                {paymentSource.SellingWallets?.map((wallet: any, index: number) => (
                  <div key={index} className="p-3 border rounded-md space-y-2">
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
                        <a
                          href={getExplorerUrl(wallet.walletAddress, network)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-mono flex-1 hover:underline text-primary"
                        >
                          {shortenAddress(wallet.walletAddress, 10)}
                        </a>
                        <CopyButton value={wallet.walletAddress} />
                      </div>
                      {wallet.collectionAddress && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Collection:</span>
                          <a
                            href={getExplorerUrl(wallet.collectionAddress, network)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-mono flex-1 hover:underline text-primary"
                          >
                            {shortenAddress(wallet.collectionAddress, 10)}
                          </a>
                          <CopyButton value={wallet.collectionAddress} />
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
                {(!paymentSource.SellingWallets || paymentSource.SellingWallets.length === 0) && (
                  <div className="text-sm text-muted-foreground">No selling wallets found</div>
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
                    <div className="flex items-center gap-2">
                      <a
                        href={getExplorerUrl(
                          paymentSource.FeeReceiverNetworkWallet.walletAddress,
                          network,
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-mono flex-1 hover:underline text-primary"
                      >
                        {shortenAddress(paymentSource.FeeReceiverNetworkWallet.walletAddress, 10)}
                      </a>
                      <CopyButton value={paymentSource.FeeReceiverNetworkWallet.walletAddress} />
                    </div>
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
