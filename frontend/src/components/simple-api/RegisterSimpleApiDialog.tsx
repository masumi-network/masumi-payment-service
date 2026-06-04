import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postSimpleApiRegister } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { extractApiErrorMessage } from '@/lib/api-error';
import { AlertCircle, Loader2 } from 'lucide-react';

const CATEGORIES = [
  'Inference',
  'Data',
  'Media',
  'Search',
  'Social',
  'Infrastructure',
  'Trading',
  'Other',
];

const registerSchema = z.object({
  network: z.enum(['Preprod', 'Mainnet'] as const),
  url: z
    .string()
    .url('Must be a valid URL (e.g. https://api.example.com/v1/chat)')
    .max(500, 'URL must be less than 500 characters'),
  name: z.string().min(1, 'Name is required').max(250, 'Name must be less than 250 characters'),
  description: z.string().max(500, 'Description must be less than 500 characters').optional(),
  category: z.string().max(100).optional(),
  tags: z.string().optional(),
});

type RegisterFormValues = z.infer<typeof registerSchema>;

interface RegisterSimpleApiDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function RegisterSimpleApiDialog({
  open,
  onClose,
  onSuccess,
}: RegisterSimpleApiDialogProps) {
  const { apiClient, network } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      network: network === 'Mainnet' ? 'Mainnet' : 'Preprod',
      url: '',
      name: '',
      description: '',
      category: undefined,
      tags: '',
    },
  });

  const handleClose = () => {
    reset();
    setFormError(null);
    onClose();
  };

  const onSubmit = async (values: RegisterFormValues) => {
    setIsSubmitting(true);
    setFormError(null);

    const tags =
      values.tags
        ?.split(',')
        .map((t) => t.trim())
        .filter(Boolean) ?? [];

    try {
      const response = await postSimpleApiRegister({
        client: apiClient,
        body: {
          network: values.network,
          url: values.url,
          name: values.name,
          description: values.description || undefined,
          category: values.category || undefined,
          tags: tags.length > 0 ? tags : undefined,
        },
      });

      if (response.error) {
        throw response.error;
      }

      if (!response.data?.data?.listing?.id) {
        throw new Error('Registration failed: unexpected response from server.');
      }

      toast.success(`"${values.name}" registered successfully. It will appear once synced.`);
      reset();
      setFormError(null);
      onSuccess();
      onClose();
    } catch (err) {
      const msg = extractApiErrorMessage(
        err,
        'Registration failed. Check the URL returns HTTP 402 or exposes a /services.json manifest.',
      );
      setFormError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Register Simple API Service</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground -mt-2">
          The service URL must return a valid HTTP 402 response or expose a{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">/services.json</code> manifest.
        </p>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
          {/* Network */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Network</label>
            <Controller
              name="network"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select network" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Preprod">Preprod (Testnet)</SelectItem>
                    <SelectItem value="Mainnet">Mainnet</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* URL */}
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Service URL <span className="text-destructive">*</span>
            </label>
            <Input
              {...register('url')}
              placeholder="https://api.example.com/v1/endpoint"
              autoComplete="off"
            />
            {errors.url && <p className="text-xs text-destructive">{errors.url.message}</p>}
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
            </label>
            <Input {...register('name')} placeholder="e.g. My Inference API" />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Description</label>
            <Textarea
              {...register('description')}
              placeholder="Brief description of what this service does"
              rows={3}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
          </div>

          {/* Category */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Category</label>
            <Controller
              name="category"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value ?? 'none'}
                  onValueChange={(v) => field.onChange(v === 'none' ? undefined : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select category (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No category</SelectItem>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* Tags */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Tags</label>
            <Input {...register('tags')} placeholder="llm, summarize, rag (comma-separated)" />
            <p className="text-xs text-muted-foreground">Separate multiple tags with commas</p>
          </div>

          {/* Form-level error banner */}
          {formError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Registering…
                </>
              ) : (
                'Register Service'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
