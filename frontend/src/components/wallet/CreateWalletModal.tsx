import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState } from "react";

type CreateWalletModalProps = {
  type: string;
  onClose: () => void;
}

type WalletFormData = {
  name: string;
  network: string;
  smartContract?: string;
  blockfrostKey?: string;
}

export function CreateWalletModal({ type, onClose }: CreateWalletModalProps) {
  const [formData, setFormData] = useState<WalletFormData>({
    name: '',
    network: 'mainnet',
    smartContract: '',
    blockfrostKey: ''
  });
  const [error, setError] = useState<string>('');

  const handleCreate = async () => {
    setError('');

    if (!formData.name.trim()) {
      setError('Wallet name is required');
      return;
    }

    if (!formData.network) {
      setError('Network selection is required');
      return;
    }

    if (type === 'hot') {
      if (!formData.smartContract) {
        setError('Smart contract selection is required');
        return;
      }

      if (formData.smartContract === 'custom' && !formData.blockfrostKey?.trim()) {
        setError('Blockfrost API key is required for custom smart contracts');
        return;
      }
    }

    try {
      console.log('Creating wallet:', { type, ...formData });
      onClose();
    } catch (error) {
      console.error('Failed to create wallet:', error);
      setError('Failed to create wallet. Please try again.');
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Create {type ? type.charAt(0).toUpperCase() + type.slice(1) : ''} Wallet
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          {error && (
            <div className="text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Wallet Name <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              className="w-full p-2 rounded-md bg-background border"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="Enter wallet name"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Network <span className="text-destructive">*</span>
            </label>
            <select
              className="w-full p-2 rounded-md bg-background border"
              value={formData.network}
              onChange={(e) => setFormData({ ...formData, network: e.target.value })}
              required
            >
              <option value="mainnet">Mainnet</option>
              <option value="preprod">Preprod</option>
            </select>
          </div>

          {type === 'hot' && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Smart Contract <span className="text-destructive">*</span>
                </label>
                <select
                  className="w-full p-2 rounded-md bg-background border"
                  value={formData.smartContract}
                  onChange={(e) => setFormData({ ...formData, smartContract: e.target.value })}
                  required
                >
                  <option value="">Select Smart Contract</option>
                  <option value="masumi_v1">Standard Masumi SC v1</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {formData.smartContract === 'custom' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Blockfrost API Key <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    value={formData.blockfrostKey}
                    onChange={(e) => setFormData({ ...formData, blockfrostKey: e.target.value })}
                    placeholder="Enter your Blockfrost API key"
                    required
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate}>
            Create Wallet
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
} 