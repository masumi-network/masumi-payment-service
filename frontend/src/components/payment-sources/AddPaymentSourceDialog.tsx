import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postPaymentSourceExtended, postWallet } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { X } from 'lucide-react';

interface AddPaymentSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type FormData = {
  network: 'Mainnet' | 'Preprod';
  paymentType: 'Web3CardanoV1';
  blockfrostApiKey: string;
  feeReceiverWallet: { walletAddress: string };
  feePermille: number | null;
  purchasingWallets: {
    walletMnemonic: string;
    note?: string;
    collectionAddress?: string;
  }[];
  sellingWallets: {
    walletMnemonic: string;
    note?: string;
    collectionAddress?: string;
  }[];
};

export function AddPaymentSourceDialog({
  open,
  onClose,
  onSuccess,
}: AddPaymentSourceDialogProps) {
  const { apiClient, state } = useAppContext();
  const [formData, setFormData] = useState<FormData>({
    network: state.network,
    paymentType: 'Web3CardanoV1',
    blockfrostApiKey: '',
    feeReceiverWallet: { walletAddress: '' },
    feePermille: 50,
    purchasingWallets: [
      { walletMnemonic: '', note: '', collectionAddress: '' },
    ],
    sellingWallets: [{ walletMnemonic: '', note: '', collectionAddress: '' }],
  });

  useEffect(() => {
    setFormData((prev) => ({
      ...prev,
      network: state.network,
    }));
  }, [state.network]);

  const [error, setError] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async () => {
    setError('');
    setIsLoading(true);

    try {
      if (!formData.blockfrostApiKey.trim()) {
        setError('Blockfrost API key is required');
        return;
      }

      if (!formData.feeReceiverWallet.walletAddress.trim()) {
        setError('Fee receiver wallet is required');
        return;
      }

      // Create three admin wallets
      const adminWallets = [];
      for (let i = 0; i < 3; i++) {
        try {
          const response = await postWallet({
            client: apiClient,
            body: {
              network: formData.network,
            },
          });

          if (!response?.data?.walletAddress) {
            throw new Error(`Failed to create admin wallet ${i + 1}`);
          }

          adminWallets.push({ walletAddress: response.data.walletAddress });

          // Store the mnemonic securely - you might want to show this to the user
          console.log(
            `Admin Wallet ${i + 1} Mnemonic:`,
            response.data.walletMnemonic,
          );
        } catch (error) {
          throw new Error(
            `Failed to create admin wallet ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      if (adminWallets.length !== 3) {
        throw new Error('Failed to create all required admin wallets');
      }

      await postPaymentSourceExtended({
        client: apiClient,
        body: {
          network: formData.network,
          paymentType: formData.paymentType,
          PaymentSourceConfig: {
            rpcProviderApiKey: formData.blockfrostApiKey,
            rpcProvider: 'Blockfrost',
          },
          feeRatePermille: formData.feePermille,
          AdminWallets: adminWallets as [
            { walletAddress: string },
            { walletAddress: string },
            { walletAddress: string },
          ],
          FeeReceiverNetworkWallet: formData.feeReceiverWallet,
          PurchasingWallets: formData.purchasingWallets
            .filter((w) => w.walletMnemonic.trim())
            .map((w) => ({
              walletMnemonic: w.walletMnemonic,
              collectionAddress: w.collectionAddress?.trim() || null,
              note: w.note || '',
            })),
          SellingWallets: formData.sellingWallets
            .filter((w) => w.walletMnemonic.trim())
            .map((w) => ({
              walletMnemonic: w.walletMnemonic,
              collectionAddress: w.collectionAddress?.trim() || null,
              note: w.note || '',
            })),
        },
      });

      toast.success('Payment source created successfully');
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Error creating payment source:', error);
      setError(
        error instanceof Error
          ? error.message
          : 'Failed to create payment source',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const addPurchasingWallet = () => {
    setFormData({
      ...formData,
      purchasingWallets: [
        ...formData.purchasingWallets,
        { walletMnemonic: '', note: '', collectionAddress: '' },
      ],
    });
  };

  const addSellingWallet = () => {
    setFormData({
      ...formData,
      sellingWallets: [
        ...formData.sellingWallets,
        { walletMnemonic: '', note: '', collectionAddress: '' },
      ],
    });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Payment Source</DialogTitle>
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
                  <option value="Preprod">Preprod</option>
                  <option value="Mainnet">Mainnet</option>
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
                  value={formData.feePermille || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      feePermille: parseInt(e.target.value) || null,
                    })
                  }
                  min="0"
                  max="1000"
                />
              </div>
            </div>
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
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  value={wallet.collectionAddress || ''}
                  onChange={(e) => {
                    const newWallets = [...formData.purchasingWallets];
                    newWallets[index].collectionAddress = e.target.value;
                    setFormData({ ...formData, purchasingWallets: newWallets });
                  }}
                  placeholder="Collection Address (optional)"
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
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  value={wallet.collectionAddress || ''}
                  onChange={(e) => {
                    const newWallets = [...formData.sellingWallets];
                    newWallets[index].collectionAddress = e.target.value;
                    setFormData({ ...formData, sellingWallets: newWallets });
                  }}
                  placeholder="Collection Address (optional)"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? 'Creating...' : 'Create Payment Source'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
