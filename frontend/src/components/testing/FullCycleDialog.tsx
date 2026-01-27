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
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  postPayment,
  postPurchase,
  PostPaymentResponse,
  PostPurchaseResponse,
} from '@/lib/api/generated';
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
  generatePurchaseCurl,
  extractErrorMessage,
} from './utils';
import { RefreshCw, ArrowRight, CheckCircle2 } from 'lucide-react';

interface FullCycleDialogProps {
  open: boolean;
  onClose: () => void;
}

const fullCycleSchema = z.object({
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

type FullCycleFormValues = z.infer<typeof fullCycleSchema>;

export function FullCycleDialog({ open, onClose }: FullCycleDialogProps) {
  const { apiClient, network, apiKey } = useAppContext();
  const { agents, isLoading: isLoadingAgents } = useAgents();
  const [step, setStep] = useState<1 | 2>(1);
  const [isLoadingPayment, setIsLoadingPayment] = useState(false);
  const [isLoadingPurchase, setIsLoadingPurchase] = useState(false);
  
  const [paymentCurl, setPaymentCurl] = useState<string>('');
  const [purchaseCurl, setPurchaseCurl] = useState<string>('');
  
  const [paymentResponse, setPaymentResponse] = useState<PostPaymentResponse['data'] | null>(null);
  const [purchaseResponse, setPurchaseResponse] = useState<PostPurchaseResponse['data'] | null>(null);
  
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  // Store form data for use in step 2
  const [formData, setFormData] = useState<FullCycleFormValues | null>(null);

  // Ref to store timeout ID for cleanup
  const purchaseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<FullCycleFormValues>({
    resolver: zodResolver(fullCycleSchema),
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
      setStep(1);
      setPaymentResponse(null);
      setPurchaseResponse(null);
      setPaymentError(null);
      setPurchaseError(null);
      setPaymentCurl('');
      setPurchaseCurl('');
      setFormData(null);
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

  const onSubmitPayment = useCallback(
    async (data: FullCycleFormValues) => {
      try {
        setIsLoadingPayment(true);
        setPaymentError(null);
        setFormData(data);

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
        setPaymentCurl(curl);

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
          const payment = result.data.data;
          setPaymentResponse(payment);
          toast.success('Payment created successfully');

          // Automatically proceed to create purchase
          purchaseTimeoutRef.current = setTimeout(() => {
            createPurchaseAutomatically(payment, data);
          }, 500);
        } else {
          throw new Error('Invalid response from server - no data returned');
        }
      } catch (err: unknown) {
        const errorMessage = extractErrorMessage(err, 'Failed to create payment');
        setPaymentError(errorMessage);
        toast.error(errorMessage);
        console.error('Payment creation error:', err);
      } finally {
        setIsLoadingPayment(false);
      }
    },
    [apiClient, apiKey, network],
  );

  const createPurchaseAutomatically = async (
    payment: PostPaymentResponse['data'],
    originalFormData: FullCycleFormValues,
  ) => {
    try {
      setIsLoadingPurchase(true);
      setPurchaseError(null);
      setStep(2);

      const requestBody = {
        blockchainIdentifier: payment.blockchainIdentifier,
        network: network,
        inputHash: originalFormData.inputHash,
        sellerVkey: payment.SmartContractWallet?.walletVkey || '',
        agentIdentifier: payment.agentIdentifier || '',
        identifierFromPurchaser: originalFormData.identifierFromPurchaser,
        payByTime: payment.payByTime || '',
        submitResultTime: payment.submitResultTime || '',
        unlockTime: payment.unlockTime || '',
        externalDisputeUnlockTime: payment.externalDisputeUnlockTime || '',
        metadata: originalFormData.metadata || undefined,
      };

      // Generate curl command
      const baseUrl = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL || '';
      const curl = generatePurchaseCurl(baseUrl, apiKey || '', requestBody);
      setPurchaseCurl(curl);

      // Call API
      const result = await postPurchase({
        client: apiClient,
        body: requestBody,
      });

      // Check for API error response
      if (result.error) {
        throw new Error(extractErrorMessage(result.error, 'Purchase creation failed'));
      }

      if (result.data?.data) {
        setPurchaseResponse(result.data.data);
        toast.success('Purchase created successfully - Full cycle complete!');
      } else {
        throw new Error('Invalid response from server - no data returned');
      }
    } catch (err: unknown) {
      const errorMessage = extractErrorMessage(err, 'Failed to create purchase');
      setPurchaseError(errorMessage);
      toast.error(errorMessage);
      console.error('Purchase creation error:', err);
    } finally {
      setIsLoadingPurchase(false);
    }
  };

  const handleClose = () => {
    // Clear any pending purchase timeout
    if (purchaseTimeoutRef.current) {
      clearTimeout(purchaseTimeoutRef.current);
      purchaseTimeoutRef.current = null;
    }
    reset();
    setStep(1);
    setPaymentResponse(null);
    setPurchaseResponse(null);
    setPaymentError(null);
    setPurchaseError(null);
    setPaymentCurl('');
    setPurchaseCurl('');
    setFormData(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[800px] h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Full Payment Cycle</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            Create a complete payment-to-purchase cycle for testing.
          </p>
        </DialogHeader>

        {/* Progress indicator */}
        <div className="flex items-center gap-2 py-4 border-b shrink-0">
          <div className="flex items-center gap-2 flex-1">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full ${
                step >= 1 ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}
            >
              {paymentResponse ? <CheckCircle2 className="h-5 w-5" /> : '1'}
            </div>
            <span className="text-sm font-medium">Create Payment</span>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <div className="flex items-center gap-2 flex-1">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full ${
                step >= 2 ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}
            >
              {purchaseResponse ? <CheckCircle2 className="h-5 w-5" /> : '2'}
            </div>
            <span className="text-sm font-medium">Create Purchase</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Step 1: Payment Form */}
          {step === 1 && !paymentResponse && (
            <form onSubmit={handleSubmit(onSubmitPayment)} className="space-y-4">
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
                  No paid agents available. Free agents cannot be used with the payment/purchase flow.
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
                <p className="text-sm text-red-500">
                  {errors.inputHash.message}
                </p>
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
                placeholder="Optional metadata"
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
                  isLoadingPayment ||
                  isLoadingAgents ||
                  paidAgents.length === 0
                }
              >
                {isLoadingPayment ? (
                  <>
                    <Spinner className="h-4 w-4 mr-2" />
                    Creating Payment...
                  </>
                ) : (
                  'Start Full Cycle'
                )}
              </Button>
            </div>
          </form>
        )}

        {/* Results */}
        {paymentResponse && (
          <div className="space-y-4">
            <div className="bg-muted/50 p-4 rounded-lg space-y-2">
              <h3 className="font-medium flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                Step 1: Payment Created
              </h3>
              <CurlResponseViewer
                curlCommand={paymentCurl}
                response={paymentResponse}
                error={paymentError}
              />
            </div>

            {isLoadingPurchase && (
              <div className="flex items-center justify-center py-8">
                <Spinner className="h-8 w-8 mr-3" />
                <span>Creating purchase automatically...</span>
              </div>
            )}

            {(purchaseResponse || purchaseError) && (
              <div className="bg-muted/50 p-4 rounded-lg space-y-2">
                <h3 className="font-medium flex items-center gap-2">
                  {purchaseResponse && (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  )}
                  Step 2: Purchase {purchaseResponse ? 'Created' : 'Failed'}
                </h3>
                <CurlResponseViewer
                  curlCommand={purchaseCurl}
                  response={purchaseResponse}
                  error={purchaseError}
                />
              </div>
            )}

            <div className="flex justify-end pt-4">
              <Button onClick={handleClose}>Close</Button>
            </div>
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
