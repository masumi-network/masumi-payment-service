/* eslint-disable @typescript-eslint/no-explicit-any */
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useAppContext } from "@/lib/contexts/AppContext";
import { createWallet } from "@/lib/query/api/wallet";

type CreateWalletModalProps = {
  type: string;
  onClose: () => void;
  contractId: string;
}

export function CreateWalletModal({ type, onClose, contractId }: CreateWalletModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const { state, dispatch } = useAppContext();


  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await createWallet(state.apiKey!, {
        id: contractId,
        walletType: type,
        includeSecret: true,
      });

      const { data } = response;

      // Update global state with new wallet
      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload: state.paymentSources.map((c: any) =>
          c.id === contractId ? data : c
        ),
      });

      onClose();
    } catch (error: any) {
      setError(error.message || 'Failed to create wallet');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create {type.charAt(0).toUpperCase() + type.slice(1)} Wallet</DialogTitle>
      </DialogHeader>

      <form onSubmit={handleCreate} className="space-y-4">
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            {error}
          </div>
        )}

        {/* Add wallet creation form fields here */}

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
            disabled={isLoading}
          >
            {isLoading ? "Creating..." : "Create Wallet"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
} 