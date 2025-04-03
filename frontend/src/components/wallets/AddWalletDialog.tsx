/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useState, useEffect } from 'react';
import {
  patchPaymentSourceExtended,
  getPaymentSourceExtended,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { parseError } from '@/lib/utils';

interface AddWalletDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function AddWalletDialog({
  open,
  onClose,
  onSuccess,
}: AddWalletDialogProps) {
  const [type, setType] = useState<'Purchasing' | 'Selling'>('Purchasing');
  const [mnemonic, setMnemonic] = useState('');
  const [note, setNote] = useState<string>('');
  const [collectionAddress, setCollectionAddress] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [paymentSourceId, setPaymentSourceId] = useState<string | null>(null);
  const { apiClient } = useAppContext();

  useEffect(() => {
    if (open) {
      fetchPaymentSource();
    } else {
      setMnemonic('');
      setNote('');
      setCollectionAddress('');
      setError('');
    }
  }, [open]);

  const fetchPaymentSource = async () => {
    try {
      const response = await getPaymentSourceExtended({
        client: apiClient,
      });

      if (response.data?.data?.ExtendedPaymentSources?.[0]?.id) {
        setPaymentSourceId(response.data.data.ExtendedPaymentSources[0].id);
      } else {
        setError('No payment source found');
        onClose();
      }
    } catch (error) {
      console.error('Error fetching payment source:', error);
      setError('Failed to load payment source');
      onClose();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!paymentSourceId) {
      setError('No payment source available');
      return;
    }

    if (!mnemonic.trim()) {
      setError('Mnemonic phrase is required');
      return;
    }

    if (!note.trim()) {
      setError('Note is required');
      return;
    }

    if (!collectionAddress.trim()) {
      setError(
        `${type === 'Purchasing' ? 'Refund' : 'Revenue'} collection address is required`,
      );
      return;
    }

    setIsLoading(true);

    try {
      const response: any = await patchPaymentSourceExtended({
        client: apiClient,
        body: {
          id: paymentSourceId,
          [type === 'Purchasing'
            ? 'AddPurchasingWallets'
            : 'AddSellingWallets']: [
            {
              walletMnemonic: mnemonic.trim(),
              note: note.trim(),
              collectionAddress: collectionAddress.trim(),
            },
          ],
        },
      });

      if (response.status === 200) {
        toast.success(`${type} wallet added successfully`);
        onSuccess?.();
        onClose();
      } else {
        const err: any = parseError(response?.error);
        setError(err?.message || err.code || err);
      }
    } catch (error: any) {
      console.error(error);
      if (error.message) {
        setError(error.message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add {type} Wallet</DialogTitle>
          <DialogDescription>
            Enter the wallet mnemonic phrase and required details to set up your{' '}
            {type.toLowerCase()} wallet.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Wallet type</label>
            <Select
              value={type}
              onValueChange={(value: 'Purchasing' | 'Selling') =>
                setType(value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select wallet type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Purchasing">Purchasing wallet</SelectItem>
                <SelectItem value="Selling">Selling wallet</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {type === 'Purchasing'
                ? 'A purchasing wallet is used to make payments for Agentic AI services. It will be used to send payments to sellers.'
                : 'A selling wallet is used to receive payments for Agentic AI services. It will be used to collect funds from buyers.'}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Mnemonic Phrase <span className="text-destructive">*</span>
            </label>
            <Textarea
              value={mnemonic}
              onChange={(e) => setMnemonic(e.target.value)}
              placeholder="Enter your mnemonic phrase"
              required
              className="min-h-[100px] font-mono"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Note <span className="text-destructive">*</span>
            </label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Enter a note to identify this wallet"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {type === 'Purchasing' ? 'Refund' : 'Revenue'} Collection Address{' '}
              <span className="text-destructive">*</span>
            </label>
            <Input
              value={collectionAddress}
              onChange={(e) => setCollectionAddress(e.target.value)}
              placeholder={`Enter the address where ${type === 'Purchasing' ? 'refunds' : 'revenue'} will be sent`}
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !mnemonic.trim() ||
                !note.trim() ||
                !collectionAddress.trim() ||
                isLoading
              }
            >
              {isLoading ? 'Adding...' : 'Add Wallet'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
