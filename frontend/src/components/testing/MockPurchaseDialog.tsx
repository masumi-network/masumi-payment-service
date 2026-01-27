import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useState, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  postPurchase,
  postPaymentResolveBlockchainIdentifier,
  PostPurchaseResponse,
  PostPaymentResolveBlockchainIdentifierResponse,
} from '@/lib/api/generated';

// Type for the payment data we receive from resolve-blockchain-identifier
type PaymentData = PostPaymentResolveBlockchainIdentifierResponse['data'];
import { toast } from 'react-toastify';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Spinner } from '@/components/ui/spinner';
import { CurlResponseViewer } from './CurlResponseViewer';
import { generatePurchaseCurl, decodeBlockchainIdentifier, extractErrorMessage } from './utils';
import { Search } from 'lucide-react';

interface MockPurchaseDialogProps {
  open: boolean;
  onClose: () => void;
}

const mockPurchaseSchema = z.object({
  blockchainIdentifier: z.string().min(1, 'Blockchain identifier required'),
  sellerVkey: z.string().optional(),
  inputHash: z.string().optional(),
  agentIdentifier: z.string().optional(),
  identifierFromPurchaser: z.string().optional(),
  payByTime: z.string().optional(),
  submitResultTime: z.string().optional(),
  unlockTime: z.string().optional(),
  externalDisputeUnlockTime: z.string().optional(),
  metadata: z.string().optional(),
});

type MockPurchaseFormValues = z.infer<typeof mockPurchaseSchema>;

export function MockPurchaseDialog({ open, onClose }: MockPurchaseDialogProps) {
  const { apiClient, network, apiKey } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [paymentData, setPaymentData] = useState<PaymentData | null>(null);
  const [curlCommand, setCurlCommand] = useState<string>('');
  const [response, setResponse] = useState<PostPurchaseResponse['data'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<MockPurchaseFormValues>({
    resolver: zodResolver(mockPurchaseSchema),
    defaultValues: {
      blockchainIdentifier: '',
      sellerVkey: '',
      inputHash: '',
      agentIdentifier: '',
      identifierFromPurchaser: '',
      payByTime: '',
      submitResultTime: '',
      unlockTime: '',
      externalDisputeUnlockTime: '',
      metadata: '',
    },
  });

  const blockchainIdentifier = watch('blockchainIdentifier');

  const handleLookupPayment = async () => {
    if (!blockchainIdentifier) {
      toast.error('Please enter a blockchain identifier');
      return;
    }

    try {
      setIsLookingUp(true);
      setError(null);

      // First, try to decode the identifier to get purchaserId
      const decoded = decodeBlockchainIdentifier(blockchainIdentifier);

      // Call the resolve API
      const result = await postPaymentResolveBlockchainIdentifier({
        client: apiClient,
        body: {
          blockchainIdentifier,
          network,
        },
      });

      // Check for API error response
      if (result.error) {
        throw new Error(extractErrorMessage(result.error, 'Payment lookup failed'));
      }

      if (result.data?.data) {
        const payment = result.data.data;
        setPaymentData(payment);

        // Auto-fill form fields
        setValue('sellerVkey', payment.SmartContractWallet?.walletVkey || '');
        setValue('inputHash', payment.inputHash || '');
        setValue('agentIdentifier', payment.agentIdentifier || '');
        setValue('payByTime', payment.payByTime || '');
        setValue('submitResultTime', payment.submitResultTime || '');
        setValue('unlockTime', payment.unlockTime || '');
        setValue(
          'externalDisputeUnlockTime',
          payment.externalDisputeUnlockTime || '',
        );

        // Extract identifierFromPurchaser from decoded blockchain identifier
        if (decoded) {
          setValue('identifierFromPurchaser', decoded.purchaserId);
        } else {
          toast.warning(
            'Could not decode purchaser identifier from blockchain identifier. Please enter it manually.',
          );
        }

        toast.success('Payment data loaded successfully');
      } else {
        throw new Error('Payment not found - no data returned');
      }
    } catch (err: unknown) {
      const errorMessage = extractErrorMessage(err, 'Failed to lookup payment');
      setError(errorMessage);
      toast.error(errorMessage);
      console.error('Payment lookup error:', err);
    } finally {
      setIsLookingUp(false);
    }
  };

  const onSubmit = useCallback(
    async (data: MockPurchaseFormValues) => {
      if (
        !data.sellerVkey ||
        !data.inputHash ||
        !data.agentIdentifier ||
        !data.identifierFromPurchaser ||
        !data.payByTime ||
        !data.submitResultTime ||
        !data.unlockTime ||
        !data.externalDisputeUnlockTime
      ) {
        toast.error('Please lookup payment data first');
        return;
      }

      try {
        setIsLoading(true);
        setError(null);

        const requestBody = {
          blockchainIdentifier: data.blockchainIdentifier,
          network: network,
          inputHash: data.inputHash,
          sellerVkey: data.sellerVkey,
          agentIdentifier: data.agentIdentifier,
          identifierFromPurchaser: data.identifierFromPurchaser,
          payByTime: data.payByTime,
          submitResultTime: data.submitResultTime,
          unlockTime: data.unlockTime,
          externalDisputeUnlockTime: data.externalDisputeUnlockTime,
          metadata: data.metadata || undefined,
        };

        // Generate curl command
        const baseUrl = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL || '';
        const curl = generatePurchaseCurl(baseUrl, apiKey || '', requestBody);
        setCurlCommand(curl);

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
          setResponse(result.data.data);
          toast.success('Mock purchase created successfully');
        } else {
          throw new Error('Invalid response from server - no data returned');
        }
      } catch (err: unknown) {
        const errorMessage = extractErrorMessage(err, 'Failed to create purchase');
        setError(errorMessage);
        toast.error(errorMessage);
        console.error('Purchase creation error:', err);
      } finally {
        setIsLoading(false);
      }
    },
    [apiClient, apiKey, network],
  );

  const handleClose = () => {
    reset();
    setPaymentData(null);
    setResponse(null);
    setError(null);
    setCurlCommand('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[700px] h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Create Mock Purchase</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            Create a test purchase request from a payment's blockchain
            identifier.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Step 1: Blockchain Identifier Lookup */}
          <div className="space-y-2 pb-4 border-b">
            <label className="text-sm font-medium">
              Step 1: Blockchain Identifier{' '}
              <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <Input
                {...register('blockchainIdentifier')}
                placeholder="Paste blockchain identifier from payment response"
                className={`font-mono text-xs flex-1 ${errors.blockchainIdentifier ? 'border-red-500' : ''}`}
              />
              <Button
                type="button"
                onClick={handleLookupPayment}
                disabled={isLookingUp || !blockchainIdentifier}
              >
                {isLookingUp ? (
                  <>
                    <Spinner className="h-4 w-4 mr-2" />
                    Looking up...
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-2" />
                    Lookup
                  </>
                )}
              </Button>
            </div>
            {errors.blockchainIdentifier && (
              <p className="text-sm text-red-500">
                {errors.blockchainIdentifier.message}
              </p>
            )}
          </div>

          {/* Step 2: Auto-filled fields */}
          {paymentData && (
            <div className="space-y-4">
              <div className="text-sm font-medium text-muted-foreground">
                Step 2: Review Auto-filled Data
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Seller VKey</label>
                  <Input
                    {...register('sellerVkey')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Input Hash</label>
                  <Input
                    {...register('inputHash')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>

                <div className="space-y-2 col-span-2">
                  <label className="text-sm font-medium">
                    Agent Identifier
                  </label>
                  <Input
                    {...register('agentIdentifier')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>

                <div className="space-y-2 col-span-2">
                  <label className="text-sm font-medium">
                    Purchaser Identifier
                  </label>
                  <Input
                    {...register('identifierFromPurchaser')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Pay By Time</label>
                  <Input
                    {...register('payByTime')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Submit Result Time
                  </label>
                  <Input
                    {...register('submitResultTime')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Unlock Time</label>
                  <Input
                    {...register('unlockTime')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    External Dispute Unlock Time
                  </label>
                  <Input
                    {...register('externalDisputeUnlockTime')}
                    className="font-mono text-xs"
                    readOnly
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Metadata (Optional)
                </label>
                <Textarea
                  {...register('metadata')}
                  placeholder="Optional metadata for the purchase"
                  rows={3}
                  className="resize-none"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end items-center gap-2 pt-4">
            <Button variant="outline" onClick={handleClose} type="button">
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !paymentData}>
              {isLoading ? (
                <>
                  <Spinner className="h-4 w-4 mr-2" />
                  Creating...
                </>
              ) : (
                'Create Purchase'
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
