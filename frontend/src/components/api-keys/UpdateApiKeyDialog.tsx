/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { patchApiKey } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PatchApiKeyResponse } from '@/lib/api/generated/types.gen';
import { parseError } from '@/lib/utils';

interface UpdateApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  apiKey: {
    id: string;
    token: string;
    permission: 'Read' | 'ReadAndPay' | 'Admin';
    networkLimit: Array<'Preprod' | 'Mainnet'>;
    usageLimited: boolean;
    status: 'Active' | 'Revoked';
  };
}

export function UpdateApiKeyDialog({
  open,
  onClose,
  onSuccess,
  apiKey,
}: UpdateApiKeyDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [status, setStatus] = useState<'Active' | 'Revoked'>(apiKey.status);
  const [credits, setCredits] = useState({
    lovelace: '',
    usdm: '',
  });
  const { apiClient } = useAppContext();

  const validateForm = () => {
    if (newToken && newToken.length < 15) {
      toast.error('Token must be at least 15 characters long');
      return false;
    }

    if (credits.lovelace && isNaN(parseFloat(credits.lovelace))) {
      toast.error('Invalid ADA amount');
      return false;
    }

    if (credits.usdm && isNaN(parseFloat(credits.usdm))) {
      toast.error('Invalid USDM amount');
      return false;
    }

    if (
      !newToken &&
      status === apiKey.status &&
      !credits.lovelace &&
      !credits.usdm
    ) {
      toast.error('Please make at least one change to update');
      return false;
    }

    return true;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    try {
      setIsLoading(true);

      const usageCredits = [];
      if (credits.lovelace) {
        usageCredits.push({
          unit: 'lovelace',
          amount: (parseFloat(credits.lovelace) * 1000000).toString(),
        });
      }
      if (credits.usdm) {
        usageCredits.push({
          unit: 'usdm',
          amount: credits.usdm,
        });
      }

      const response = await patchApiKey({
        client: apiClient,
        body: {
          id: apiKey.id,
          ...(newToken && { token: newToken }),
          ...(status !== apiKey.status && { status }),
          ...(usageCredits.length > 0 && {
            UsageCreditsToAddOrRemove: usageCredits,
          }),
        },
      });

      const responseData = response?.data as PatchApiKeyResponse;
      if (!responseData?.data?.id) {
        throw new Error(
          'Failed to update API key: Invalid response from server',
        );
      }

      toast.success('API key updated successfully');
      onSuccess();
      handleClose();
    } catch (error: any) {
      console.error('Error updating API key:', error);
      toast.error(parseError(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setNewToken('');
    setStatus(apiKey.status);
    setCredits({ lovelace: '', usdm: '' });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update API key</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">New Token (Optional)</label>
            <Input
              type="text"
              placeholder="Leave empty to keep current token"
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Must be at least 15 characters if provided
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <Select
              value={status}
              onValueChange={(value: 'Active' | 'Revoked') => setStatus(value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Revoked">Revoked</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Add/Remove ADA Credits
              </label>
              <Input
                type="number"
                placeholder="Enter amount (positive to add, negative to remove)"
                value={credits.lovelace}
                onChange={(e) =>
                  setCredits((prev) => ({ ...prev, lovelace: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Amount in ADA (will be converted to lovelace)
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Add/Remove USDM Credits
              </label>
              <Input
                type="number"
                placeholder="Enter amount (positive to add, negative to remove)"
                value={credits.usdm}
                onChange={(e) =>
                  setCredits((prev) => ({ ...prev, usdm: e.target.value }))
                }
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? 'Updating...' : 'Update'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
