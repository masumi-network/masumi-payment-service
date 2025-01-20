/* eslint-disable @typescript-eslint/no-explicit-any */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState } from "react";

type ImportWalletModalProps = {
  type: any;
  onClose: () => void;
}

type ImportData = {
  seedPhrase: string;
  network: string;
  smartContract?: string;
  blockfrostKey?: string;
}

export function ImportWalletModal({ type, onClose }: ImportWalletModalProps) {
  const [importData, setImportData] = useState<ImportData>({
    seedPhrase: '',
    network: 'mainnet',
    smartContract: '',
    blockfrostKey: ''
  });
  const [error, setError] = useState<string>('');

  const handleImport = async () => {
    setError('');

    if (!importData.seedPhrase.trim()) {
      setError('Seed phrase is required');
      return;
    }

    if (!importData.network) {
      setError('Network selection is required');
      return;
    }

    if (type === 'hot') {
      if (!importData.smartContract) {
        setError('Smart contract selection is required');
        return;
      }

      if (importData.smartContract === 'custom' && !importData.blockfrostKey?.trim()) {
        setError('Blockfrost API key is required for custom smart contracts');
        return;
      }
    }

    try {
      console.log('Importing wallet:', { type, ...importData });
      onClose();
    } catch (error) {
      console.error('Failed to import wallet:', error);
      setError('Failed to import wallet. Please try again.');
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import {type.charAt(0).toUpperCase() + type.slice(1)} Wallet</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <div className="text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Seed Phrase <span className="text-destructive">*</span>
            </label>
            <textarea
              className="w-full p-2 rounded-md bg-background border min-h-[100px]"
              value={importData.seedPhrase}
              onChange={(e) => setImportData({ ...importData, seedPhrase: e.target.value })}
              placeholder="Enter your 24-word seed phrase"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Network <span className="text-destructive">*</span>
            </label>
            <select
              className="w-full p-2 rounded-md bg-background border"
              value={importData.network}
              onChange={(e) => setImportData({ ...importData, network: e.target.value })}
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
                  value={importData.smartContract}
                  onChange={(e) => setImportData({ ...importData, smartContract: e.target.value })}
                  required
                >
                  <option value="">Select Smart Contract</option>
                  <option value="masumi_v1">Standard Masumi SC v1</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {importData.smartContract === 'custom' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Blockfrost API Key <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    value={importData.blockfrostKey}
                    onChange={(e) => setImportData({ ...importData, blockfrostKey: e.target.value })}
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
          <Button onClick={handleImport}>
            Import Wallet
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
} 