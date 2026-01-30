import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postPayment, PostPaymentResponse } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAgents } from '@/lib/queries/useAgents';
import { Spinner } from '@/components/ui/spinner';
import { CurlResponseViewer } from './CurlResponseViewer';
import {
  generateRandomHex,
  calculateDefaultTimes,
  generatePaymentCurl,
  extractErrorMessage,
} from './utils';
import {
  PaymentFormFields,
  useInputDataHash,
  paymentFormSchema,
  type PaymentFormValues,
} from './PaymentFormFields';

interface MockPaymentDialogProps {
  open: boolean;
  onClose: () => void;
}

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
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      agentIdentifier: '',
      inputHash: '',
      identifierFromPurchaser: '',
      metadata: '',
    },
  });

  const paidAgents = agents.filter(
    (agent) =>
      agent.state === 'RegistrationConfirmed' &&
      agent.agentIdentifier !== null &&
      agent.AgentPricing?.pricingType !== 'Free',
  );

  const { inputData, setInputData, inputDataError, resetInputData } = useInputDataHash(
    setValue,
    watch,
  );

  useEffect(() => {
    if (open) {
      resetInputData();
      setValue('identifierFromPurchaser', generateRandomHex(16));
      setResponse(null);
      setError(null);
      setCurlCommand('');
    }
  }, [open, setValue, resetInputData]);

  const onSubmit = useCallback(
    async (data: PaymentFormValues) => {
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

        const baseUrl = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL || '';
        const curl = generatePaymentCurl(baseUrl, apiKey || '', requestBody);
        setCurlCommand(curl);

        const result = await postPayment({
          client: apiClient,
          body: requestBody,
        });

        if (result.error) {
          throw new Error(extractErrorMessage(result.error, 'Payment creation failed'));
        }

        if (result.data?.data) {
          setResponse(result.data.data);
          toast.success('Test payment created successfully');
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
    resetInputData(false);
    setResponse(null);
    setError(null);
    setCurlCommand('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[700px] h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Create Test Payment</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            Create a test payment request for development and testing purposes.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            <PaymentFormFields
              register={register}
              setValue={setValue}
              watch={watch}
              control={control}
              errors={errors}
              paidAgents={paidAgents}
              isLoadingAgents={isLoadingAgents}
              inputData={inputData}
              setInputData={setInputData}
              inputDataError={inputDataError}
            />

            <div className="flex justify-end items-center gap-2 pt-2 border-t">
              <Button variant="outline" onClick={handleClose} type="button">
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isLoading || isLoadingAgents || paidAgents.length === 0}
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
          <CurlResponseViewer curlCommand={curlCommand} response={response} error={error} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
