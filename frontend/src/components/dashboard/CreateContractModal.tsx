import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { X } from 'lucide-react';
import {
  postPaymentSourceExtended,
  getPaymentSource,
} from '@/lib/api/generated';

type CreateContractModalProps = {
  onClose: () => void;
};

type FormData = {
  network: 'Mainnet' | 'Preprod';
  paymentType: 'Web3CardanoV1';
  blockfrostApiKey: string;
  adminWallets: { walletAddress: string }[];
  feeReceiverWallet: { walletAddress: string };
  feePermille: number;
  collectionWallet: {
    walletAddress: string;
    note?: string;
  };
  purchasingWallets: {
    walletMnemonic: string;
    note?: string;
  }[];
  sellingWallets: {
    walletMnemonic: string;
    note?: string;
  }[];
};

const initialFormData: FormData = {
  network: 'Preprod',
  paymentType: 'Web3CardanoV1',
  blockfrostApiKey: '',
  adminWallets: [{ walletAddress: '' }],
  feeReceiverWallet: { walletAddress: '' },
  feePermille: 50,
  collectionWallet: { walletAddress: '', note: '' },
  purchasingWallets: [{ walletMnemonic: '', note: '' }],
  sellingWallets: [{ walletMnemonic: '', note: '' }],
};

export function CreateContractModal({ onClose }: CreateContractModalProps) {
  const [formData, setFormData] = useState<FormData>({
    ...initialFormData,
  });
  const [error, setError] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const { dispatch } = useAppContext();
  const { apiClient } = useAppContext();

  const handleAdd = async () => {
    setError('');
    setIsLoading(true);

    try {
      if (!formData.blockfrostApiKey.trim()) {
        setError('Blockfrost API key is required');
        return;
      }

      if (!formData.adminWallets.some((w) => w.walletAddress.trim())) {
        setError('At least one admin wallet is required');
        return;
      }

      if (!formData.feeReceiverWallet.walletAddress.trim()) {
        setError('Fee receiver wallet is required');
        return;
      }

      if (!formData.collectionWallet.walletAddress.trim()) {
        setError('Collection wallet is required');
        return;
      }

      if (formData.adminWallets.length != 3) {
        setError('At least 3 admin wallets are required');
        return;
      }

      await postPaymentSourceExtended({
        client: apiClient,
        body: {
          AdminWallets: formData.adminWallets
            .filter((w) => w.walletAddress.trim())
            .slice(0, 3) as [
            { walletAddress: string },
            { walletAddress: string },
            { walletAddress: string },
          ],
          network: formData.network,
          paymentType: formData.paymentType,
          feeRatePermille: formData.feePermille,
          FeeReceiverNetworkWallet: formData.feeReceiverWallet,
          PurchasingWallets: formData.purchasingWallets
            .filter((w) => w.walletMnemonic.trim())
            .map((w) => ({
              walletMnemonic: w.walletMnemonic,
              collectionAddress: formData.collectionWallet.walletAddress.trim(),
              note: w.note || '',
            })),
          SellingWallets: formData.sellingWallets
            .filter((w) => w.walletMnemonic.trim())
            .map((w) => ({
              walletMnemonic: w.walletMnemonic,
              collectionAddress: formData.collectionWallet.walletAddress.trim(),
              note: w.note || '',
            })),
          PaymentSourceConfig: {
            rpcProviderApiKey: formData.blockfrostApiKey,
            rpcProvider: 'Blockfrost',
          },
        },
      });

      //TODO: refetch all
      const sourcesData = await getPaymentSource({
        client: apiClient,
        query: {
          cursorId: undefined,
          take: 100,
        },
      });

      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload: sourcesData?.data?.data?.PaymentSources || [],
      });

      onClose();
    } catch (error: unknown) {
      console.error('Failed to create payment source:', error);
      setError(
        error instanceof Error
          ? error.message
          : 'Failed to create payment source. Please try again.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const addAdminWallet = () => {
    setFormData({
      ...formData,
      adminWallets: [...formData.adminWallets, { walletAddress: '' }],
    });
  };

  const addPurchasingWallet = () => {
    setFormData({
      ...formData,
      purchasingWallets: [
        ...formData.purchasingWallets,
        { walletMnemonic: '' },
      ],
    });
  };

  const addSellingWallet = () => {
    setFormData({
      ...formData,
      sellingWallets: [
        ...formData.sellingWallets,
        { walletMnemonic: '', note: '' },
      ],
    });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Payment Source</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {error && <div className="text-sm text-destructive">{error}</div>}

          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Basic Configuration</h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Network <span className="text-destructive">*</span>
                </label>
                <select
                  className="w-full p-2 rounded-md bg-background border"
                  value={formData.network}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      network: e.target.value as 'Mainnet' | 'Preprod',
                    })
                  }
                >
                  <option value="PREPROD">Preprod</option>
                  <option value="MAINNET">Mainnet</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Blockfrost API Key <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  value={formData.blockfrostApiKey}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      blockfrostApiKey: e.target.value,
                    })
                  }
                  placeholder="Using default Blockfrost API key"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Fee Permille <span className="text-destructive">*</span>
                </label>
                <input
                  type="number"
                  className="w-full p-2 rounded-md bg-background border"
                  value={formData.feePermille}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      feePermille: parseInt(e.target.value),
                    })
                  }
                  min="0"
                  max="1000"
                />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">
                Admin Wallets{' '}
                <span className="text-muted-foreground">(*3 expected)</span>
              </h3>
              <Button
                type="button"
                variant="secondary"
                onClick={addAdminWallet}
              >
                Add Admin Wallet
              </Button>
            </div>

            {formData.adminWallets.map((wallet, index) => (
              <div key={index} className="space-y-2">
                <label className="text-sm font-medium">
                  Admin Wallet Address {index + 1}
                </label>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  value={wallet.walletAddress}
                  onChange={(e) => {
                    const newWallets = [...formData.adminWallets];
                    newWallets[index].walletAddress = e.target.value;
                    setFormData({ ...formData, adminWallets: newWallets });
                  }}
                  placeholder="Enter wallet address"
                />
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Fee Receiver Wallet</h3>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Wallet Address <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                className="w-full p-2 rounded-md bg-background border"
                value={formData.feeReceiverWallet.walletAddress}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    feeReceiverWallet: { walletAddress: e.target.value },
                  })
                }
                placeholder="Enter fee receiver wallet address"
              />
            </div>
          </div>

          {/* Collection Wallet */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Collection Wallet</h3>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Wallet Address <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                className="w-full p-2 rounded-md bg-background border"
                value={formData.collectionWallet.walletAddress}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    collectionWallet: {
                      ...formData.collectionWallet,
                      walletAddress: e.target.value,
                    },
                  })
                }
                placeholder="Enter collection wallet address"
              />
              <input
                type="text"
                className="w-full p-2 rounded-md bg-background border"
                value={formData.collectionWallet.note || ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    collectionWallet: {
                      ...formData.collectionWallet,
                      note: e.target.value,
                    },
                  })
                }
                placeholder="Note (optional)"
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">Purchasing Wallets</h3>
              <Button
                type="button"
                variant="secondary"
                onClick={addPurchasingWallet}
              >
                Add Purchasing Wallet
              </Button>
            </div>

            {formData.purchasingWallets.map((wallet, index) => (
              <div key={index} className="space-y-2 relative">
                <div className="text-sm font-medium flex items-center justify-start space-x-2">
                  <span>Purchasing Wallet {index + 1}</span>
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        const newWallets = formData.purchasingWallets.filter(
                          (_, i) => i !== index,
                        );
                        setFormData({
                          ...formData,
                          purchasingWallets: newWallets,
                        });
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    value={wallet.walletMnemonic}
                    onChange={(e) => {
                      const newWallets = [...formData.purchasingWallets];
                      newWallets[index].walletMnemonic = e.target.value;
                      setFormData({
                        ...formData,
                        purchasingWallets: newWallets,
                      });
                    }}
                    placeholder="Enter wallet mnemonic"
                  />
                </div>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  value={wallet.note || ''}
                  onChange={(e) => {
                    const newWallets = [...formData.purchasingWallets];
                    newWallets[index].note = e.target.value;
                    setFormData({ ...formData, purchasingWallets: newWallets });
                  }}
                  placeholder="Note (optional)"
                />
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">Selling Wallets</h3>
              <Button
                type="button"
                variant="secondary"
                onClick={addSellingWallet}
              >
                Add Selling Wallet
              </Button>
            </div>

            {formData.sellingWallets.map((wallet, index) => (
              <div key={index} className="space-y-2 relative">
                <div className="text-sm font-medium flex items-center justify-start space-x-2">
                  <span>Selling Wallet {index + 1}</span>
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        const newWallets = formData.sellingWallets.filter(
                          (_, i) => i !== index,
                        );
                        setFormData({
                          ...formData,
                          sellingWallets: newWallets,
                        });
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    value={wallet.walletMnemonic}
                    onChange={(e) => {
                      const newWallets = [...formData.sellingWallets];
                      newWallets[index].walletMnemonic = e.target.value;
                      setFormData({ ...formData, sellingWallets: newWallets });
                    }}
                    placeholder="Enter wallet mnemonic"
                  />
                </div>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  value={wallet.note || ''}
                  onChange={(e) => {
                    const newWallets = [...formData.sellingWallets];
                    newWallets[index].note = e.target.value;
                    setFormData({ ...formData, sellingWallets: newWallets });
                  }}
                  placeholder="Note (optional)"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={isLoading}>
            {isLoading ? 'Creating...' : 'Create Payment Source'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
