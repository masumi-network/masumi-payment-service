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
import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postPayment, PostPaymentResponse } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAgents } from '@/lib/queries/useAgents';
import { Spinner } from '@/components/ui/spinner';
import { CurlResponseViewer } from './CurlResponseViewer';
import {
  generateRandomHex,
  generateSHA256Hex,
  calculateDefaultTimes,
  generatePaymentCurl,
  extractErrorMessage,
} from './utils';
import { RefreshCw } from 'lucide-react';

interface MockPaymentDialogProps {
  open: boolean;
  onClose: () => void;
}

const mockPaymentSchema = z.object({
  agentIdentifier: z.string().min(57, 'Agent identifier required'),
  inputHash: z
    .string()
    .length(64, 'Input hash must be 64 characters')
    .regex(/^[0-9a-fA-F]+$/, 'Must be valid hex'),
  identifierFromPurchaser: z
    .string()
    .min(14, 'Minimum 14 characters')
    .max(26, 'Maximum 26 characters')
    .regex(/^[0-9a-fA-F]+$/, 'Must be valid hex'),
  metadata: z.string().optional(),
});

type MockPaymentFormValues = z.infer<typeof mockPaymentSchema>;

export function MockPaymentDialog({ open, onClose }: MockPaymentDialogProps) {
  const { apiClient, network, apiKey } = useAppContext();
  const { agents, isLoading: isLoadingAgents } = useAgents();
  const [isLoading, setIsLoading] = useState(false);
  const [curlCommand, setCurlCommand] = useState<string>('');
  const [response, setResponse] = useState<PostPaymentResponse['data'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<MockPaymentFormValues>({
    resolver: zodResolver(mockPaymentSchema),
    defaultValues: {
      agentIdentifier: '',
      inputHash: '',
      identifierFromPurchaser: '',
      metadata: '',
    },
  });

  // Filter to only show paid agents (not free) that are confirmed
  const paidAgents = agents.filter(
    (agent) =>
      agent.state === 'RegistrationConfirmed' &&
      agent.agentIdentifier !== null &&
      agent.AgentPricing?.pricingType !== 'Free',
  );

  // Auto-generate hash and identifier on dialog open
  useEffect(() => {
    if (open) {
      const generateDefaults = async () => {
        const randomData = generateRandomHex(32);
        const hash = await generateSHA256Hex(randomData);
        setValue('inputHash', hash);
        setValue('identifierFromPurchaser', generateRandomHex(16));
      };
      generateDefaults();
      setResponse(null);
      setError(null);
      setCurlCommand('');
    }
  }, [open, setValue]);

  const handleGenerateInputHash = async () => {
    const randomData = generateRandomHex(32);
    const hash = await generateSHA256Hex(randomData);
    setValue('inputHash', hash);
  };

  const handleGenerateIdentifier = () => {
    setValue('identifierFromPurchaser', generateRandomHex(16));
  };

  const onSubmit = useCallback(
    async (data: MockPaymentFormValues) => {
      try {
        setIsLoading(true);
        setError(null);

        const times = calculateDefaultTimes();
        const requestBody = {
          network: network,
          agentIdentifier: data.agentIdentifier,
          inputHash: data.inputHash,
          identifierFromPurchaser: data.identifierFromPurchaser,
          payByTime: times.payByTime,
          submitResultTime: times.submitResultTime,
          unlockTime: times.unlockTime,
          externalDisputeUnlockTime: times.externalDisputeUnlockTime,
          metadata: data.metadata || undefined,
        };

        // Generate curl command
        const baseUrl = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL || '';
        const curl = generatePaymentCurl(baseUrl, apiKey || '', requestBody);
        setCurlCommand(curl);

        // Call API
        const result = await postPayment({
          client: apiClient,
          body: requestBody,
        });

        // Check for API error response
        if (result.error) {
          throw new Error(extractErrorMessage(result.error, 'Payment creation failed'));
        }

        if (result.data?.data) {
          setResponse(result.data.data);
          toast.success('Mock payment created successfully');
        } else {
          throw new Error('Invalid response from server - no data returned');
        }
      } catch (err: unknown) {
        const errorMessage = extractErrorMessage(err, 'Failed to create payment');
        setError(errorMessage);
        toast.error(errorMessage);
        console.error('Payment creation error:', err);
      } finally {
        setIsLoading(false);
      }
    },
    [apiClient, apiKey, network],
  );

  const handleClose = () => {
    reset();
    setResponse(null);
    setError(null);
    setCurlCommand('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[700px] h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Create Mock Payment</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            Create a test payment request for development and testing purposes.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Agent <span className="text-red-500">*</span>
            </label>
            <Controller
              control={control}
              name="agentIdentifier"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    disabled={isLoadingAgents}
                    className={errors.agentIdentifier ? 'border-red-500' : ''}
                  >
                    <SelectValue
                      placeholder={
                        isLoadingAgents
                          ? 'Loading agents...'
                          : paidAgents.length === 0
                            ? 'No paid agents available'
                            : 'Select a paid agent'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {paidAgents.map((agent) => (
                      <SelectItem
                        key={agent.id}
                        value={agent.agentIdentifier || ''}
                      >
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.agentIdentifier && (
              <p className="text-sm text-red-500">
                {errors.agentIdentifier.message}
              </p>
            )}
            {paidAgents.length === 0 && !isLoadingAgents && (
              <p className="text-sm text-muted-foreground">
                No paid agents available. Free agents cannot be used with the payment flow.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Only paid agents (Fixed pricing) are shown. Free agents don&apos;t require payments.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center justify-between">
              <span>
                Input Hash <span className="text-red-500">*</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleGenerateInputHash}
                className="h-6 text-xs"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Regenerate
              </Button>
            </label>
            <Input
              {...register('inputHash')}
              placeholder="64-character hex string"
              className={`font-mono text-xs ${errors.inputHash ? 'border-red-500' : ''}`}
            />
            {errors.inputHash && (
              <p className="text-sm text-red-500">{errors.inputHash.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center justify-between">
              <span>
                Purchaser Identifier <span className="text-red-500">*</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleGenerateIdentifier}
                className="h-6 text-xs"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Regenerate
              </Button>
            </label>
            <Input
              {...register('identifierFromPurchaser')}
              placeholder="14-26 character hex string"
              className={`font-mono text-xs ${errors.identifierFromPurchaser ? 'border-red-500' : ''}`}
            />
            {errors.identifierFromPurchaser && (
              <p className="text-sm text-red-500">
                {errors.identifierFromPurchaser.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Metadata (Optional)</label>
            <Textarea
              {...register('metadata')}
              placeholder="Optional metadata for the payment"
              rows={3}
              className="resize-none"
            />
          </div>

          <div className="flex justify-end items-center gap-2 pt-4">
            <Button variant="outline" onClick={handleClose} type="button">
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                isLoading ||
                isLoadingAgents ||
                paidAgents.length === 0
              }
            >
              {isLoading ? (
                <>
                  <Spinner className="h-4 w-4 mr-2" />
                  Creating...
                </>
              ) : (
                'Create Payment'
              )}
            </Button>
          </div>
        </form>
        </div>

        <div className="shrink-0">
          <CurlResponseViewer
            curlCommand={curlCommand}
            response={response}
            error={error}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
