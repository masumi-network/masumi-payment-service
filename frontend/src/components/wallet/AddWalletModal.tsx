import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useAppContext } from "@/lib/contexts/AppContext";

type AddWalletModalProps = {
  type: 'purchasing' | 'selling';
  onClose: () => void;
  contractId: string;
}

export function AddWalletModal({ type, onClose, contractId }: AddWalletModalProps) {
  const [mnemonic, setMnemonic] = useState('');
  const [note, setNote] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const { state, dispatch } = useAppContext();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/update-payment-source', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.apiKey}`
        },
        body: JSON.stringify({
          id: contractId,
          [`${type === 'purchasing' ? 'AddPurchasingWallets' : 'AddSellingWallets'}`]: [
            {
              walletMnemonic: mnemonic,
              note: note || undefined
            }
            ]
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to add wallet');
      }

      const sourcesResponse = await fetch('/api/payment-source', {
        headers: {
          'Authorization': `Bearer ${state.apiKey}`
        }
      });
      if (!sourcesResponse.ok) {
        throw new Error('Failed to fetch payment sources');
      }
      
      const sourcesData = await sourcesResponse.json();
      const sources = sourcesData?.data?.paymentSources || [];
      
      const updatedContract = sources.find((c: any) => c.id === contractId);
      if (!updatedContract) {
        throw new Error('Updated contract not found in response');
      }
      
      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload: state.paymentSources.map((c: any) => 
          c.id === contractId ? updatedContract : c
        )
      });

      onClose();
    } catch (error: any) {
      setError(error.message || 'Failed to add wallet');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add {type.charAt(0).toUpperCase() + type.slice(1)} Wallet</DialogTitle>
        <DialogDescription>
          Enter the wallet mnemonic phrase and an optional note.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Mnemonic Phrase <span className="text-destructive">*</span>
          </label>
          <textarea
            className="w-full min-h-[100px] p-2 rounded-md bg-background border"
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            placeholder="Enter your 24-word mnemonic phrase"
            required
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Note (optional)</label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Enter a note for this wallet"
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
            disabled={!mnemonic || isLoading}
          >
            {isLoading ? "Adding..." : "Add Wallet"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
} 