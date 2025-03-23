import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast } from 'react-toastify';
import { shortenAddress } from '@/lib/utils';
import { postRegistry, PostRegistryData } from '@/lib/api/generated';

interface RegisterAgentModalProps {
  onClose: () => void;
  onSuccess: () => void;
  paymentContractAddress: string;
  network: 'PREPROD' | 'MAINNET';
  sellingWallets: {
    walletVkey: string;
    collectionAddress: string;
  }[];
}

const AGENT_PLACEHOLDERS = {
  name: 'Enter agent name',
  description: 'Enter agent description',
  api_url: 'https://your-api-endpoint.com',
  authorName: 'Enter author name',
  authorContact: 'Enter contact email',
  authorOrganization: 'Enter organization name',
  capabilityName: 'Enter capability name',
  capabilityVersion: 'e.g., 1.0.0',
  pricingUnit: 'e.g., usdm',
  pricingQuantity: 'e.g., 500000000',
  tags: 'tag1, tag2',
};

export function RegisterAgentModal({
  onClose,
  onSuccess,
  paymentContractAddress,
  sellingWallets,
  network,
}: RegisterAgentModalProps) {
  const { apiClient } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    api_url: '',
    authorName: '',
    authorContact: '',
    authorOrganization: '',
    capabilityName: '',
    capabilityVersion: '',
    pricingUnit: '',
    pricingQuantity: '',
    tags: [] as string[],
  });
  const [selectedWallet, setSelectedWallet] = useState(
    sellingWallets[0]?.walletVkey || '',
  );
  const [tagError, setTagError] = useState<string | null>(null);

  const handleTagChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({
      ...formData,
      tags: e.target.value.split(',').map((tag) => tag.trim()) as string[],
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    if (formData.tags.length === 0 || formData.tags[0] === '') {
      setTagError('Please enter at least one tag.');
      setIsLoading(false);
      return;
    } else {
      setTagError(null);
    }

    try {
      //TODO: update example outputs and contact email and change the requests per hour to float in the ui
      const details: PostRegistryData['body'] = {
        network: network === 'PREPROD' ? 'Preprod' : 'Mainnet',
        smartContractAddress: paymentContractAddress,
        Tags: formData.tags,
        name: formData.name,
        apiBaseUrl: formData.api_url,
        description: formData.description,
        Author: {
          name: formData.authorName,
          contactEmail: formData.authorContact || undefined,
          organization: formData.authorOrganization || undefined,
        },
        Capability: {
          name: formData.capabilityName,
          version: formData.capabilityVersion,
        },
        ExampleOutputs: [],
        AgentPricing: {
          pricingType: 'Fixed',
          Pricing: [
            {
              unit: formData.pricingUnit,
              amount: formData.pricingQuantity,
            },
          ],
        },
        Legal: {},
        sellingWalletVkey: selectedWallet,
      };
      await postRegistry({ client: apiClient, body: details });

      onSuccess();
    } catch (error) {
      console.error('Failed to register agent:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to register agent',
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[660px]">
        <DialogHeader>
          <DialogTitle>Register New Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">*Agent Name</label>
            <Input
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder={AGENT_PLACEHOLDERS.name}
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*API URL</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.api_url}
              value={formData.api_url}
              onChange={(e) =>
                setFormData({ ...formData, api_url: e.target.value })
              }
              required
              type="url"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Description</label>
            <Textarea
              placeholder={AGENT_PLACEHOLDERS.description}
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Author Name</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.authorName}
              value={formData.authorName}
              onChange={(e) =>
                setFormData({ ...formData, authorName: e.target.value })
              }
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Author Contact</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.authorContact}
              value={formData.authorContact}
              onChange={(e) =>
                setFormData({ ...formData, authorContact: e.target.value })
              }
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Author Organization</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.authorOrganization}
              value={formData.authorOrganization}
              onChange={(e) =>
                setFormData({ ...formData, authorOrganization: e.target.value })
              }
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Capability Name</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.capabilityName}
              value={formData.capabilityName}
              onChange={(e) =>
                setFormData({ ...formData, capabilityName: e.target.value })
              }
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Capability Version</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.capabilityVersion}
              value={formData.capabilityVersion}
              onChange={(e) =>
                setFormData({ ...formData, capabilityVersion: e.target.value })
              }
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Pricing Unit</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.pricingUnit}
              value={formData.pricingUnit}
              onChange={(e) =>
                setFormData({ ...formData, pricingUnit: e.target.value })
              }
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">*Pricing Quantity</label>
            <Input
              placeholder={AGENT_PLACEHOLDERS.pricingQuantity}
              value={formData.pricingQuantity}
              onChange={(e) =>
                setFormData({ ...formData, pricingQuantity: e.target.value })
              }
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Tags (comma-separated)
            </label>
            <Input
              value={formData.tags.join(', ')}
              onChange={handleTagChange}
              placeholder={AGENT_PLACEHOLDERS.tags}
              required
            />
            {tagError && <p className="text-red-500 text-sm">{tagError}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              *Select Selling Wallet
            </label>
            <Select value={selectedWallet} onValueChange={setSelectedWallet}>
              <SelectTrigger>
                <SelectValue placeholder="Select a wallet" />
              </SelectTrigger>
              <SelectContent>
                {sellingWallets.map((wallet, index) => (
                  <SelectItem key={index} value={wallet.walletVkey}>
                    {shortenAddress(wallet.collectionAddress)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end space-x-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Registering...' : 'Register Agent'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
