import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useState, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  postPurchase,
  postPaymentResolveBlockchainIdentifier,
  PostPurchaseResponse,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Spinner } from '@/components/ui/spinner';
import { CurlResponseViewer } from './CurlResponseViewer';
import { generatePurchaseCurl, decodeBlockchainIdentifier, extractErrorMessage } from './utils';
import { Search, ClipboardPaste } from 'lucide-react';

interface MockPurchaseDialogProps {
  open: boolean;
  onClose: () => void;
}

const mockPurchaseSchema = z.object({
  blockchainIdentifier: z.string().min(1, 'Blockchain identifier required'),
  sellerVkey: z.string().min(1, 'Seller VKey required'),
  inputHash: z.string().min(1, 'Input hash required'),
  agentIdentifier: z.string().min(1, 'Agent identifier required'),
  identifierFromPurchaser: z.string().min(1, 'Purchaser identifier required'),
  payByTime: z.string().min(1, 'Pay by time required'),
  submitResultTime: z.string().min(1, 'Submit result time required'),
  unlockTime: z.string().min(1, 'Unlock time required'),
  externalDisputeUnlockTime: z.string().min(1, 'External dispute unlock time required'),
  metadata: z.string().optional(),
});

type MockPurchaseFormValues = z.infer<typeof mockPurchaseSchema>;

function tryExtractPaymentFields(json: string): Partial<MockPurchaseFormValues> | null {
  try {
    let obj = JSON.parse(json);
    // Support wrapped responses: { data: { ... } } or { data: { data: { ... } } }
    if (obj.data && typeof obj.data === 'object') {
      obj = obj.data.data ? obj.data.data : obj.data;
    }
    const fields: Partial<MockPurchaseFormValues> = {};
    if (obj.blockchainIdentifier) fields.blockchainIdentifier = obj.blockchainIdentifier;
    if (obj.agentIdentifier) fields.agentIdentifier = obj.agentIdentifier;
    if (obj.inputHash) fields.inputHash = obj.inputHash;
    if (obj.SmartContractWallet?.walletVkey) fields.sellerVkey = obj.SmartContractWallet.walletVkey;
    if (obj.payByTime) fields.payByTime = obj.payByTime;
    if (obj.submitResultTime) fields.submitResultTime = obj.submitResultTime;
    if (obj.unlockTime) fields.unlockTime = obj.unlockTime;
    if (obj.externalDisputeUnlockTime)
      fields.externalDisputeUnlockTime = obj.externalDisputeUnlockTime;
    // Try to extract identifierFromPurchaser from blockchainIdentifier
    if (fields.blockchainIdentifier) {
      const decoded = decodeBlockchainIdentifier(fields.blockchainIdentifier);
      if (decoded) {
        fields.identifierFromPurchaser = decoded.purchaserId;
      }
    }
    // Only return if we got at least blockchainIdentifier
    if (fields.blockchainIdentifier) return fields;
    return null;
  } catch {
    return null;
  }
}

export function MockPurchaseDialog({ open, onClose }: MockPurchaseDialogProps) {
  const { apiClient, network, apiKey } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
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

  const applyFields = useCallback(
    (fields: Partial<MockPurchaseFormValues>) => {
      for (const [key, val] of Object.entries(fields)) {
        if (val) setValue(key as keyof MockPurchaseFormValues, val);
      }
    },
    [setValue],
  );

  const handlePasteResponse = useCallback(
    (value: string) => {
      setPasteValue(value);
      if (!value.trim()) {
        setPasteError(null);
        return;
      }
      const fields = tryExtractPaymentFields(value);
      if (fields) {
        setPasteError(null);
        applyFields(fields);
        toast.success('Fields populated from pasted response');
      } else {
        setPasteError(
          'Could not extract payment data. Paste the JSON response from Create Payment.',
        );
      }
    },
    [applyFields],
  );

  const handleLookupPayment = async () => {
    if (!blockchainIdentifier) {
      toast.error('Please enter a blockchain identifier');
      return;
    }

    try {
      setIsLookingUp(true);
      setError(null);

      const decoded = decodeBlockchainIdentifier(blockchainIdentifier);

      const result = await postPaymentResolveBlockchainIdentifier({
        client: apiClient,
        body: {
          blockchainIdentifier,
          network,
        },
      });

      if (result.error) {
        throw new Error(extractErrorMessage(result.error, 'Payment lookup failed'));
      }

      if (result.data?.data) {
        const payment = result.data.data;

        setValue('sellerVkey', payment.SmartContractWallet?.walletVkey || '');
        setValue('inputHash', payment.inputHash || '');
        setValue('agentIdentifier', payment.agentIdentifier || '');
        setValue('payByTime', payment.payByTime || '');
        setValue('submitResultTime', payment.submitResultTime || '');
        setValue('unlockTime', payment.unlockTime || '');
        setValue('externalDisputeUnlockTime', payment.externalDisputeUnlockTime || '');

        if (decoded) {
          setValue('identifierFromPurchaser', decoded.purchaserId);
        } else {
          toast.warning(
            'Could not decode purchaser identifier from blockchain identifier. Please enter it manually.',
          );
        }

        toast.success('Payment data loaded successfully');
      } else {
        throw new Error(
          'Payment not found. Note: Lookup only finds payments created through this service.',
        );
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

        const baseUrl = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL || '';
        const curl = generatePurchaseCurl(baseUrl, apiKey || '', requestBody);
        setCurlCommand(curl);

        const result = await postPurchase({
          client: apiClient,
          body: requestBody,
        });

        if (result.error) {
          throw new Error(extractErrorMessage(result.error, 'Purchase creation failed'));
        }

        if (result.data?.data) {
          setResponse(result.data.data);
          toast.success('Test purchase created successfully');
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
    setPasteValue('');
    setPasteError(null);
    setResponse(null);
    setError(null);
    setCurlCommand('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[700px] h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Create Test Purchase</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            Create a test purchase from a payment response or blockchain identifier.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            {/* Paste Payment Response */}
            <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-1">
              <Label className="flex items-center gap-1.5">
                <ClipboardPaste className="h-3.5 w-3.5" />
                Paste Payment Response
              </Label>
              <Textarea
                value={pasteValue}
                onChange={(e) => handlePasteResponse(e.target.value)}
                placeholder="Paste the JSON response from Create Payment to auto-fill all fields..."
                rows={4}
                className={`font-mono text-xs transition-colors duration-200 ${pasteError ? 'border-red-500' : ''}`}
              />
              {pasteError && <p className="text-sm text-red-500 animate-fade-in">{pasteError}</p>}
              <p className="text-xs text-muted-foreground">Or fill in the fields manually below.</p>
            </div>

            {/* Blockchain Identifier + Lookup */}
            <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-2">
              <Label>
                Blockchain Identifier <span className="text-red-500">*</span>
              </Label>
              <div className="flex gap-2">
                <Input
                  {...register('blockchainIdentifier')}
                  placeholder="Blockchain identifier"
                  className={`font-mono text-xs flex-1 transition-colors duration-200 ${errors.blockchainIdentifier ? 'border-red-500' : ''}`}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleLookupPayment}
                  disabled={isLookingUp || !blockchainIdentifier}
                  className="shrink-0 transition-opacity duration-150"
                >
                  {isLookingUp ? <Spinner className="h-4 w-4" /> : <Search className="h-4 w-4" />}
                  Lookup
                </Button>
              </div>
              {errors.blockchainIdentifier && (
                <p className="text-sm text-red-500 animate-fade-in">
                  {errors.blockchainIdentifier.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Optionally click Lookup to resolve fields from the API. Only payments created
                through this service will be found.
              </p>
            </div>

            {/* Payment Data Fields */}
            <Card className="animate-fade-in-up opacity-0 animate-stagger-3 transition-shadow duration-200 hover:shadow-md">
              <CardContent className="p-4 space-y-4">
                <p className="text-xs font-medium text-muted-foreground">Payment Data</p>

                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <div className="space-y-1.5 col-span-2">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Agent Identifier <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('agentIdentifier')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.agentIdentifier ? 'border-red-500' : ''}`}
                      placeholder="Agent identifier"
                    />
                    {errors.agentIdentifier && (
                      <p className="text-xs text-red-500 animate-fade-in">
                        {errors.agentIdentifier.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5 col-span-2">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Purchaser Identifier <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('identifierFromPurchaser')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.identifierFromPurchaser ? 'border-red-500' : ''}`}
                      placeholder="Purchaser identifier"
                    />
                    {errors.identifierFromPurchaser && (
                      <p className="text-xs text-red-500 animate-fade-in">
                        {errors.identifierFromPurchaser.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Seller VKey <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('sellerVkey')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.sellerVkey ? 'border-red-500' : ''}`}
                      placeholder="Seller verification key"
                    />
                    {errors.sellerVkey && (
                      <p className="text-xs text-red-500 animate-fade-in">
                        {errors.sellerVkey.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Input Hash <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('inputHash')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.inputHash ? 'border-red-500' : ''}`}
                      placeholder="Input hash"
                    />
                    {errors.inputHash && (
                      <p className="text-xs text-red-500 animate-fade-in">
                        {errors.inputHash.message}
                      </p>
                    )}
                  </div>
                </div>

                {/* Timing */}
                <Separator />
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Pay By <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('payByTime')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.payByTime ? 'border-red-500' : ''}`}
                      placeholder="ISO date"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Submit Result <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('submitResultTime')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.submitResultTime ? 'border-red-500' : ''}`}
                      placeholder="ISO date"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">
                      Unlock <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('unlockTime')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.unlockTime ? 'border-red-500' : ''}`}
                      placeholder="ISO date"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground font-normal">
                      External Dispute Unlock <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      {...register('externalDisputeUnlockTime')}
                      className={`font-mono text-xs transition-colors duration-200 ${errors.externalDisputeUnlockTime ? 'border-red-500' : ''}`}
                      placeholder="ISO date"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Metadata */}
            <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-4">
              <Label>Metadata (Optional)</Label>
              <Textarea
                {...register('metadata')}
                placeholder="Optional metadata for the purchase"
                rows={2}
                className="resize-none"
              />
            </div>

            <Separator />
            <div className="flex justify-end items-center gap-2">
              <Button variant="outline" onClick={handleClose} type="button">
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
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
          <CurlResponseViewer curlCommand={curlCommand} response={response} error={error} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
