import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { PostPaymentResponse } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAgents } from '@/lib/queries/useAgents';
import { Spinner } from '@/components/ui/spinner';
import { CurlResponseViewer } from './CurlResponseViewer';
import { generateRandomHex, extractErrorMessage, filterPaidAgents, createPayment } from './utils';
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

  const paidAgents = filterPaidAgents(agents);

  const { inputData, setInputData, inputDataError, resetInputData } = useInputDataHash(
    setValue,
    watch,
  );

  useEffect(() => {
    if (open) {
      resetInputData();
      setValue('identifierFromPurchaser', generateRandomHex(16));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResponse(null);
      setError(null);
      setCurlCommand('');
    }
  }, [open, setValue, resetInputData]);

  const onSubmit = useCallback(
    async (data: PaymentFormValues) => {
      setIsLoading(true);
      setError(null);

      const result = await createPayment({
        apiClient,
        network,
        agentIdentifier: data.agentIdentifier,
        inputHash: data.inputHash,
        identifierFromPurchaser: data.identifierFromPurchaser,
        metadata: data.metadata,
        apiKey: apiKey || '',
      });

      setCurlCommand(result.curlCommand);

      if (result.success && result.data) {
        setResponse(result.data);
        toast.success('Test payment created successfully');
      } else {
        const errorMessage = result.error || 'Failed to create payment';
        setError(errorMessage);
        toast.error(errorMessage);
        console.error('Payment creation error:', errorMessage);
      }

      setIsLoading(false);
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
