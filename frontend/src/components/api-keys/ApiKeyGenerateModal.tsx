import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast } from 'react-toastify';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { parseFetchError } from '@/lib/utils';

type UsageCredit = {
  unit: string;
  amount: number;
};

export function ApiKeyGenerateModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [usageLimited, setUsageLimited] = useState(true);
  const [usageCredits, setUsageCredits] = useState<UsageCredit[]>([
    { unit: 'lovelace', amount: 1000000 },
  ]);
  const { state } = useAppContext();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const response = await fetch('/api/api-keys/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.apiKey}`,
        },
        body: JSON.stringify({
          usageLimited: usageLimited.toString(),
          UsageCredits: usageLimited ? usageCredits : undefined,
          permission: 'ADMIN',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = parseFetchError(errorData, response);
        throw new Error(errorMessage);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(
          result.error.message || result.error || 'Failed to generate API key',
        );
      }

      toast.success('API key generated successfully');
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Error generating API key:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to generate API key';
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate New API Key</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-center space-x-2">
            <Switch checked={usageLimited} onCheckedChange={setUsageLimited} />
            <label>Usage Limited</label>
          </div>

          {usageLimited && (
            <div className="space-y-2">
              {usageCredits.map((credit, index) => (
                <div key={index} className="flex space-x-2">
                  <Input
                    type="text"
                    value={credit.unit}
                    onChange={(e) => {
                      const newCredits = [...usageCredits];
                      newCredits[index].unit = e.target.value;
                      setUsageCredits(newCredits);
                    }}
                    placeholder="Unit"
                  />
                  <Input
                    type="number"
                    value={credit.amount}
                    onChange={(e) => {
                      const newCredits = [...usageCredits];
                      newCredits[index].amount = parseInt(e.target.value);
                      setUsageCredits(newCredits);
                    }}
                    placeholder="Amount"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Generating...' : 'Generate'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
