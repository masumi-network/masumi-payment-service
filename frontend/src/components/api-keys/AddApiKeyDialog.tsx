import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { useAppContext } from "@/lib/contexts/AppContext";
import { postApiKey } from "@/lib/api/generated";
import { toast } from "react-toastify";
import { Checkbox } from "@/components/ui/checkbox";

interface AddApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type Network = 'Preprod' | 'Mainnet';

export function AddApiKeyDialog({ open, onClose, onSuccess }: AddApiKeyDialogProps) {
  const [permission, setPermission] = useState<'Read' | 'ReadAndPay' | 'Admin'>('Read');
  const [isLoading, setIsLoading] = useState(false);
  const [usageLimited, setUsageLimited] = useState(true);
  const [networks, setNetworks] = useState<Network[]>(['Preprod', 'Mainnet']);
  const [credits, setCredits] = useState({
    lovelace: '',
    usdm: ''
  });
  const { apiClient } = useAppContext();

  const handleNetworkToggle = (network: Network) => {
    setNetworks(prev => 
      prev.includes(network)
        ? prev.filter(n => n !== network)
        : [...prev, network]
    );
  };

  const validateForm = () => {
    if (networks.length === 0) {
      toast.error('Please select at least one network');
      return false;
    }

    if (usageLimited) {
      if (!credits.lovelace && !credits.usdm) {
        toast.error('Please specify at least one usage limit');
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
    }

    return true;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    try {
      setIsLoading(true);

      const usageCredits = [];
      if (usageLimited) {
        if (credits.lovelace) {
          usageCredits.push({
            unit: 'lovelace',
            amount: (parseFloat(credits.lovelace) * 1000000).toString()
          });
        }
        if (credits.usdm) {
          usageCredits.push({
            unit: 'usdm',
            amount: credits.usdm
          });
        }
      }

      await postApiKey({
        client: apiClient,
        body: {
          permission,
          usageLimited: usageLimited.toString(),
          networkLimit: networks,
          UsageCredits: usageCredits
        }
      });

      toast.success('API key created successfully');
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Error creating API key:', error);
      toast.error('Failed to create API key');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setPermission('Read');
    setUsageLimited(true);
    setNetworks(['Preprod', 'Mainnet']);
    setCredits({ lovelace: '', usdm: '' });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add API key</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Permission</label>
            <Select value={permission} onValueChange={(value: 'Read' | 'ReadAndPay' | 'Admin') => setPermission(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Read">Read</SelectItem>
                <SelectItem value="ReadAndPay">Read and Pay</SelectItem>
                <SelectItem value="Admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Networks</label>
            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <Checkbox 
                  checked={networks.includes('Preprod')}
                  onCheckedChange={() => handleNetworkToggle('Preprod')}
                />
                <label className="text-sm">Preprod</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox 
                  checked={networks.includes('Mainnet')}
                  onCheckedChange={() => handleNetworkToggle('Mainnet')}
                />
                <label className="text-sm">Mainnet</label>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox 
                checked={usageLimited}
                onCheckedChange={(checked) => setUsageLimited(checked as boolean)}
              />
              <label className="text-sm font-medium">Limit Usage</label>
            </div>
          </div>

          {usageLimited && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">ADA Limit</label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={credits.lovelace}
                  onChange={(e) => setCredits(prev => ({ ...prev, lovelace: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">Amount in ADA (will be converted to lovelace)</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">USDM Limit</label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={credits.usdm}
                  onChange={(e) => setCredits(prev => ({ ...prev, usdm: e.target.value }))}
                />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
} 