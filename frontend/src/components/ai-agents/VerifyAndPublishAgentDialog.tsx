import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CopyButton } from '@/components/ui/copy-button';
import { RegistryEntry, postSignatureSignVerifyAndPublishAgent } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { extractApiErrorMessage } from '@/lib/api-error';
import { shortenAddress } from '@/lib/utils';
import { toast } from 'react-toastify';

interface VerifyAndPublishAgentDialogProps {
  agent: RegistryEntry | null;
  open: boolean;
  onClose: () => void;
  /** When parent AIAgentDetailsDialog uses elevatedStack (over transaction modal). */
  elevatedChildStack?: boolean;
}

interface VerifyAndPublishSignatureResult {
  signature: string;
  key: string;
  walletAddress: string;
  signatureData: string;
}

export function VerifyAndPublishAgentDialog({
  agent,
  open,
  onClose,
  elevatedChildStack,
}: VerifyAndPublishAgentDialogProps) {
  const { apiClient } = useAppContext();
  const [publicKey, setPublicKey] = useState('');
  const [result, setResult] = useState<VerifyAndPublishSignatureResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setPublicKey('');
      setResult(null);
      setIsSubmitting(false);
    }
  }, [open]);

  const handleGenerate = async () => {
    if (!agent?.agentIdentifier) {
      toast.error('This agent does not have a registered agent identifier yet.');
      return;
    }

    const trimmedPublicKey = publicKey.trim();
    if (trimmedPublicKey === '') {
      toast.error('Public key is required.');
      return;
    }

    try {
      setIsSubmitting(true);

      const response = await postSignatureSignVerifyAndPublishAgent({
        client: apiClient,
        body: {
          publicKey: trimmedPublicKey,
          agentIdentifier: agent.agentIdentifier,
          action: 'VerifyAndPublishAgent',
        },
      });

      const signatureResult = response.data?.data;
      if (!signatureResult) {
        throw new Error('Failed to generate verify-and-publish signature');
      }

      setResult(signatureResult);
      toast.success('Verification signature generated successfully');
    } catch (error) {
      toast.error(extractApiErrorMessage(error, 'Failed to generate verify-and-publish signature'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl" elevatedChildStack={elevatedChildStack}>
        <DialogHeader>
          <DialogTitle>Verify and Publish Agent</DialogTitle>
          <DialogDescription>
            Generate a signed verification payload for{' '}
            <strong>{agent?.name ?? 'this agent'}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Agent Identifier</label>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {agent?.agentIdentifier
                  ? shortenAddress(agent.agentIdentifier, 8)
                  : 'Not available'}
              </span>
              {agent?.agentIdentifier && <CopyButton value={agent.agentIdentifier} />}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="verify-publish-public-key" className="text-sm font-medium">
              Public Key
            </label>
            <Input
              id="verify-publish-public-key"
              value={publicKey}
              onChange={(event) => {
                setPublicKey(event.target.value);
                if (result) {
                  setResult(null);
                }
              }}
              placeholder="Paste the public key used for wallet verification"
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">
              The generated signature will bind this public key to the selected registered agent.
            </p>
          </div>

          {result && (
            <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">Wallet Address</label>
                  <CopyButton value={result.walletAddress} />
                </div>
                <Input value={result.walletAddress} readOnly className="font-mono text-xs" />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">Key</label>
                  <CopyButton value={result.key} />
                </div>
                <Textarea value={result.key} readOnly className="min-h-24 font-mono text-xs" />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">Signature</label>
                  <CopyButton value={result.signature} />
                </div>
                <Textarea
                  value={result.signature}
                  readOnly
                  className="min-h-24 font-mono text-xs"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">Signature Data</label>
                  <CopyButton value={result.signatureData} />
                </div>
                <Textarea
                  value={result.signatureData}
                  readOnly
                  className="min-h-28 font-mono text-xs"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} type="button">
              Close
            </Button>
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={isSubmitting || !agent?.agentIdentifier || publicKey.trim() === ''}
            >
              {isSubmitting ? 'Generating...' : 'Generate Signature'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
