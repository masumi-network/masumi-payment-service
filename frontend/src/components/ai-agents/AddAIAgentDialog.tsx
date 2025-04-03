/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */

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
import { useState, useEffect } from 'react';
import { Badge } from '../ui/badge';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postRegistry, getPaymentSource } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { shortenAddress } from '@/lib/utils';

interface AddAIAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface SellingWallet {
  id: string;
  walletVkey: string;
  walletAddress: string;
  note: string | null;
}

export function AddAIAgentDialog({
  open,
  onClose,
  onSuccess,
}: AddAIAgentDialogProps) {
  const [apiUrl, setApiUrl] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedWallet, setSelectedWallet] = useState('');
  const [price, setPrice] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [currentTag, setCurrentTag] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sellingWallets, setSellingWallets] = useState<SellingWallet[]>([]);
  const { apiClient, state } = useAppContext();

  useEffect(() => {
    if (open) {
      fetchSellingWallets();
    }
  }, [open]);

  const fetchSellingWallets = async () => {
    try {
      const response = await getPaymentSource({
        client: apiClient,
      });

      if (response.data?.data?.PaymentSources) {
        const paymentSource = response.data.data.PaymentSources[0];
        if (paymentSource) {
          setSellingWallets(paymentSource.SellingWallets);
        }
      }
    } catch (error) {
      console.error('Error fetching selling wallets:', error);
      toast.error('Failed to load selling wallets');
    }
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!apiUrl.trim()) {
      newErrors.apiUrl = 'API URL is required';
    } else if (
      !apiUrl.startsWith('http://') &&
      !apiUrl.startsWith('https://')
    ) {
      newErrors.apiUrl = 'API URL must start with http:// or https://';
    }

    if (!name.trim()) {
      newErrors.name = 'Name is required';
    }

    if (!description.trim()) {
      newErrors.description = 'Description is required';
    }

    if (!selectedWallet) {
      newErrors.selectedWallet = 'Wallet is required';
    }

    if (!price || parseFloat(price) <= 0) {
      newErrors.price = 'Price must be greater than 0';
    }

    if (tags.length === 0) {
      newErrors.tags = 'At least one tag is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleAddTag = (tag: string) => {
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
      setErrors((prev) => ({ ...prev, tags: '' }));
    }
    setCurrentTag('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const newTags = tags.filter((tag) => tag !== tagToRemove);
    setTags(newTags);
    if (newTags.length === 0) {
      setErrors((prev) => ({ ...prev, tags: 'At least one tag is required' }));
    }
  };

  const resetForm = () => {
    setApiUrl('');
    setName('');
    setDescription('');
    setSelectedWallet('');
    setPrice('');
    setTags([]);
    setCurrentTag('');
    setErrors({});
  };

  const handleSubmit = async () => {
    if (!validateForm()) {
      return;
    }

    try {
      setIsLoading(true);

      const response = await postRegistry({
        client: apiClient,
        body: {
          network: state.network,
          sellingWalletVkey: selectedWallet,
          name,
          description,
          apiBaseUrl: apiUrl,
          Tags: tags,
          Capability: {
            name: 'Custom Agent',
            version: '1.0.0',
          },
          AgentPricing: {
            pricingType: 'Fixed',
            Pricing: [
              {
                unit: 'lovelace',
                amount: (parseFloat(price) * 1000000).toString(),
              },
            ],
          },
          Author: {
            name: 'Admin',
          },
          ExampleOutputs: [],
        },
      });

      if (!response.data?.data?.id) {
        throw new Error(
          'Failed to create AI agent: Invalid response from server',
        );
      }

      toast.success('AI agent created successfully');
      onSuccess();
      onClose();
      resetForm();
    } catch (error: any) {
      console.error('Error creating AI agent:', error);
      toast.error(error?.message ?? 'Failed to create AI agent');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add AI agent</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              API URL <span className="text-red-500">*</span>
            </label>
            <Input
              placeholder="Enter the API URL for your agent"
              value={apiUrl}
              onChange={(e) => {
                setApiUrl(e.target.value);
                setErrors((prev) => ({ ...prev, apiUrl: '' }));
              }}
              className={errors.apiUrl ? 'border-red-500' : ''}
            />
            {errors.apiUrl && (
              <p className="text-sm text-red-500">{errors.apiUrl}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Name <span className="text-red-500">*</span>
            </label>
            <Input
              placeholder="Enter a name for your agent"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((prev) => ({ ...prev, name: '' }));
              }}
              className={errors.name ? 'border-red-500' : ''}
            />
            {errors.name && (
              <p className="text-sm text-red-500">{errors.name}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Description <span className="text-red-500">*</span>
            </label>
            <Textarea
              placeholder="Describe what your agent does"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setErrors((prev) => ({ ...prev, description: '' }));
              }}
              rows={3}
              className={errors.description ? 'border-red-500' : ''}
            />
            {errors.description && (
              <p className="text-sm text-red-500">{errors.description}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Linked wallet <span className="text-red-500">*</span>
            </label>
            <Select
              value={selectedWallet}
              onValueChange={(value) => {
                setSelectedWallet(value);
                setErrors((prev) => ({ ...prev, selectedWallet: '' }));
              }}
            >
              <SelectTrigger
                className={errors.selectedWallet ? 'border-red-500' : ''}
              >
                <SelectValue placeholder="Select a wallet" />
              </SelectTrigger>
              <SelectContent>
                {sellingWallets.map((wallet) => (
                  <SelectItem key={wallet.id} value={wallet.walletVkey}>
                    {wallet.note
                      ? `${wallet.note} (${shortenAddress(wallet.walletAddress)})`
                      : shortenAddress(wallet.walletAddress)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.selectedWallet && (
              <p className="text-sm text-red-500">{errors.selectedWallet}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Price (ADA) <span className="text-red-500">*</span>
            </label>
            <Input
              type="number"
              placeholder="0.00"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setErrors((prev) => ({ ...prev, price: '' }));
              }}
              min="0"
              step="0.000001"
              className={errors.price ? 'border-red-500' : ''}
            />
            {errors.price && (
              <p className="text-sm text-red-500">{errors.price}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Tags <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="Add a tag"
                value={currentTag}
                onChange={(e) => setCurrentTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag(currentTag);
                  }
                }}
                className={errors.tags ? 'border-red-500' : ''}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => handleAddTag(currentTag)}
              >
                Add
              </Button>
            </div>
            {errors.tags && (
              <p className="text-sm text-red-500">{errors.tags}</p>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="cursor-pointer"
                    onClick={() => handleRemoveTag(tag)}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-4">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isLoading}>
              {isLoading ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
