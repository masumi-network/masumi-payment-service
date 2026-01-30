import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postPurchase, PostPaymentResponse, PostPurchaseResponse } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAgents } from '@/lib/queries/useAgents';
import { Spinner } from '@/components/ui/spinner';
import { CurlResponseViewer } from './CurlResponseViewer';
import {
  generateRandomHex,
  generatePurchaseCurl,
  extractErrorMessage,
  filterPaidAgents,
  createPayment,
} from './utils';
import {
  PaymentFormFields,
  useInputDataHash,
  paymentFormSchema,
  type PaymentFormValues,
} from './PaymentFormFields';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowRight, CheckCircle2 } from 'lucide-react';

interface FullCycleDialogProps {
  open: boolean;
  onClose: () => void;
}

export function FullCycleDialog({ open, onClose }: FullCycleDialogProps) {
  const { apiClient, network, apiKey } = useAppContext();
  const { agents, isLoading: isLoadingAgents } = useAgents();
  const [step, setStep] = useState<1 | 2>(1);
  const [isLoadingPayment, setIsLoadingPayment] = useState(false);
  const [isLoadingPurchase, setIsLoadingPurchase] = useState(false);

  const [paymentCurl, setPaymentCurl] = useState<string>('');
  const [purchaseCurl, setPurchaseCurl] = useState<string>('');

  const [paymentResponse, setPaymentResponse] = useState<PostPaymentResponse['data'] | null>(null);
  const [purchaseResponse, setPurchaseResponse] = useState<PostPurchaseResponse['data'] | null>(
    null,
  );

  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const purchaseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      agentIdentifier: '',
      inputHash: '',
      identifierFromPurchaser: '',
      metadata: '',
    },
  });

  const paidAgents = filterPaidAgents(agents);

  const { inputData, setInputData, inputDataError, resetInputData } = useInputDataHash(
    setValue,
    watch,
  );

  useEffect(() => {
    if (open) {
      resetInputData();
      setValue('identifierFromPurchaser', generateRandomHex(16));
      setStep(1);
      setPaymentResponse(null);
      setPurchaseResponse(null);
      setPaymentError(null);
      setPurchaseError(null);
      setPaymentCurl('');
      setPurchaseCurl('');
    }
  }, [open, setValue, resetInputData]);

  const createPurchaseAutomatically = useCallback(
    async (payment: PostPaymentResponse['data'], originalFormData: PaymentFormValues) => {
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

        const baseUrl = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL || '';
        const curl = generatePurchaseCurl(baseUrl, apiKey || '', requestBody);
        setPurchaseCurl(curl);

        const result = await postPurchase({
          client: apiClient,
          body: requestBody,
        });

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
    },
    [apiClient, apiKey, network],
  );

  const onSubmitPayment = useCallback(
    async (data: PaymentFormValues) => {
      setIsLoadingPayment(true);
      setPaymentError(null);

      const result = await createPayment({
        apiClient,
        network,
        agentIdentifier: data.agentIdentifier,
        inputHash: data.inputHash,
        identifierFromPurchaser: data.identifierFromPurchaser,
        metadata: data.metadata,
        apiKey: apiKey || '',
      });

      setPaymentCurl(result.curlCommand);

      if (result.success && result.data) {
        const payment = result.data;
        setPaymentResponse(payment);
        toast.success('Payment created successfully');

        purchaseTimeoutRef.current = setTimeout(() => {
          createPurchaseAutomatically(payment, data);
        }, 500);
      } else {
        const errorMessage = result.error || 'Failed to create payment';
        setPaymentError(errorMessage);
        toast.error(errorMessage);
        console.error('Payment creation error:', errorMessage);
      }

      setIsLoadingPayment(false);
    },
    [apiClient, apiKey, network, createPurchaseAutomatically],
  );

  const handleClose = () => {
    if (purchaseTimeoutRef.current) {
      clearTimeout(purchaseTimeoutRef.current);
      purchaseTimeoutRef.current = null;
    }
    reset();
    resetInputData(false);
    setStep(1);
    setPaymentResponse(null);
    setPurchaseResponse(null);
    setPaymentError(null);
    setPurchaseError(null);
    setPaymentCurl('');
    setPurchaseCurl('');
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
        <div className="flex items-center gap-3 py-3 shrink-0">
          <div className="flex items-center gap-2 flex-1">
            <div
              className={`flex items-center justify-center w-7 h-7 rounded-full text-sm transition-all duration-300 ${
                step >= 1 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {paymentResponse ? <CheckCircle2 className="h-4 w-4 animate-pulse-success" /> : '1'}
            </div>
            <span className="text-sm font-medium">Payment</span>
            {paymentResponse && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 animate-fade-in">
                Done
              </Badge>
            )}
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex items-center gap-2 flex-1">
            <div
              className={`flex items-center justify-center w-7 h-7 rounded-full text-sm transition-all duration-300 ${
                step >= 2 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {purchaseResponse ? <CheckCircle2 className="h-4 w-4 animate-pulse-success" /> : '2'}
            </div>
            <span className="text-sm font-medium">Purchase</span>
            {purchaseResponse && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 animate-fade-in">
                Done
              </Badge>
            )}
          </div>
        </div>
        <Separator />

        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Step 1: Payment Form */}
          {step === 1 && !paymentResponse && (
            <form onSubmit={handleSubmit(onSubmitPayment)} className="space-y-6">
              <PaymentFormFields
                register={register}
                setValue={setValue}
                control={control}
                errors={errors}
                paidAgents={paidAgents}
                isLoadingAgents={isLoadingAgents}
                inputData={inputData}
                setInputData={setInputData}
                inputDataError={inputDataError}
              />

              <Separator />
              <div className="flex justify-end items-center gap-2">
                <Button variant="outline" onClick={handleClose} type="button">
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isLoadingPayment || isLoadingAgents || paidAgents.length === 0}
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
              <div className="space-y-2">
                <h3 className="font-medium flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Payment Created
                </h3>
                <CurlResponseViewer
                  curlCommand={paymentCurl}
                  response={paymentResponse}
                  error={paymentError}
                />
              </div>

              {isLoadingPurchase && (
                <div className="flex items-center justify-center py-6">
                  <Spinner className="h-6 w-6 mr-3" />
                  <span className="text-sm text-muted-foreground">
                    Creating purchase automatically...
                  </span>
                </div>
              )}

              {(purchaseResponse || purchaseError) && (
                <div className="space-y-2">
                  <h3 className="font-medium flex items-center gap-2 text-sm">
                    {purchaseResponse ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : null}
                    Purchase {purchaseResponse ? 'Created' : 'Failed'}
                  </h3>
                  <CurlResponseViewer
                    curlCommand={purchaseCurl}
                    response={purchaseResponse}
                    error={purchaseError}
                  />
                </div>
              )}

              <div className="flex justify-end pt-2 border-t">
                <Button onClick={handleClose}>Close</Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
