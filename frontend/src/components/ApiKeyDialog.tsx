import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useState } from "react";
import { useAppContext } from "@/lib/contexts/AppContext";
import { toast } from 'react-toastify';
import { getPaymentSources } from "@/lib/query/api/payment-source";

export function ApiKeyDialog() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { dispatch } = useAppContext();

  const handleApiKeySubmit = async (key: string) => {
    setError("");
    setIsLoading(true);

    try {

      await getPaymentSources(key);

      const hexKey = Buffer.from(key).toString('hex');
      localStorage.setItem("payment_api_key", hexKey);
      dispatch({ type: 'SET_API_KEY', payload: key });
      toast.success('API key validated successfully');

    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'Failed to validate API key');
      localStorage.removeItem("payment_api_key");
      toast.error('Failed to validate API key');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent className="sm:max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>Enter API Key</DialogTitle>
          <DialogDescription>
            Please enter your payment API key to continue
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => {
          e.preventDefault();
          handleApiKeySubmit(apiKey);
        }}
          className="space-y-4">
          {error && (
            <div className="text-sm text-destructive">
              {error}
            </div>
          )}

          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your API key"
            required
          />

          <div className="flex justify-end">
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Validating..." : "Submit"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
