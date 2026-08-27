import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  postPurchase,
  postPaymentResolveBlockchainIdentifier,
  PostPurchaseResponse,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Spinner } from '@/components/ui/spinner';
import { CurlResponseViewer } from './CurlResponseViewer';
import { generatePurchaseCurl, decodeBlockchainIdentifier, extractErrorMessage } from './utils';
import { Search, ClipboardPaste, Wallet } from 'lucide-react';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import { useWallets } from '@/lib/queries/useWallets';
import { useAllAgents } from '@/lib/queries/useAgents';
import { buildPaidAgentOptions } from './payment-options';
import { shortenAddress } from '@/lib/utils';
import { CopyButton } from '@/components/ui/copy-button';
import { lookupWalletByVkey } from '@/lib/wallet-lookup';

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

interface ExtractedPaymentFields {
  formFields: Partial<MockPurchaseFormValues>;
  pricingType?: string;
  amounts?: Array<{ amount: string; unit: string }>;
  /** Seller-signed routing choice from the payment response; must be round-tripped. */
  paymentForceLayer?: 'L1' | 'Hydra' | null;
  /**
   * Where the seller wants their funds returned, as signed into the identifier.
   *
   * Round-tripped for the same reason as the routing choice, and for one more:
   * the server falls back to the seller's collection address *as stored in its
   * own database*, which a buyer on a different node has never seen. It resolves
   * to null there, the reconstructed payload stops matching what the seller
   * signed, and the purchase is rejected as "signature invalid" with nothing
   * pointing at the cause.
   */
  sellerReturnAddress?: string | null;
  /**
   * Which entry of the agent's `supported_payment_sources` the seller priced
   * against. V2 signs this into the identifier too, but unlike the fields above
   * it cannot be read back: `createPayment` takes it as input only and no
   * response echoes it. Omitting it drops the key from the payload the server
   * reconstructs, so the purchase is rejected as "signature invalid" — the same
   * failure the seller-return-address note above describes.
   *
   * A non-null value here only marks the identifier as V2 — the actual index is
   * resolved in the component, which can look the agent up. It is NOT safely 0:
   * the index counts every entry of `supported_payment_sources`, x402/EVM ones
   * included, and registration submits them in dialog row order (see
   * buildOrderedSupportedPaymentSources), so an agent with a single Cardano
   * source still sits at index 1 if an EVM source was listed above it.
   */
  supportedPaymentSourceIndex?: number | null;
}

function tryExtractPaymentFields(json: string): ExtractedPaymentFields | null {
  try {
    let obj = JSON.parse(json);
    // Support wrapped responses: { data: { ... } } or { data: { data: { ... } } }
    if (obj.data && typeof obj.data === 'object') {
      obj = obj.data.data ? obj.data.data : obj.data;
    }
    const fields: Partial<MockPurchaseFormValues> = {};
    const sellerReturnAddress =
      typeof obj.sellerReturnAddress === 'string' ? obj.sellerReturnAddress : null;
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
    // Extract pricingType and amounts from RequestedFunds
    const pricingType = obj.pricingType;
    const amounts =
      Array.isArray(obj.RequestedFunds) && obj.RequestedFunds.length > 0
        ? obj.RequestedFunds.map((f: { amount: string; unit: string }) => ({
            amount: f.amount,
            unit: f.unit,
          }))
        : undefined;
    // A payment response carries the seller's signed routing choice as
    // `forceLayer`; a purchase response carries it as `paymentForceLayer` (its
    // own `forceLayer` is the BUYER override). Prefer the explicit field so a
    // pasted purchase response doesn't misread the buyer's choice as the seller's.
    const rawSellerForce =
      obj.paymentForceLayer !== undefined ? obj.paymentForceLayer : obj.forceLayer;
    const paymentForceLayer =
      rawSellerForce === 'L1' || rawSellerForce === 'Hydra'
        ? (rawSellerForce as 'L1' | 'Hydra')
        : null;
    // Never present on a payment response, so fall back to 0 whenever the
    // identifier is V2 (only V2 carries a smartContractAddress, and only V2
    // signs this key at all).
    const supportedPaymentSourceIndex =
      typeof obj.supportedPaymentSourceIndex === 'number'
        ? obj.supportedPaymentSourceIndex
        : fields.blockchainIdentifier &&
            decodeBlockchainIdentifier(fields.blockchainIdentifier)?.smartContractAddress != null
          ? 0
          : null;
    // Only return if we got at least blockchainIdentifier
    if (fields.blockchainIdentifier)
      return {
        formFields: fields,
        pricingType,
        amounts,
        paymentForceLayer,
        sellerReturnAddress,
        supportedPaymentSourceIndex,
      };
    return null;
  } catch {
    return null;
  }
}

export function MockPurchaseDialog({ open, onClose }: MockPurchaseDialogProps) {
  const { apiClient, network, apiKey, selectedPaymentSource } = useAppContext();
  const resync = useResync();
  // Both deferred until the dialog is open. `useAllAgents` walks every
  // inclusive-cursor page before it publishes anything, so running it on a
  // closed dialog is the same eager fan-out the wallet gate exists to stop.
  const { wallets } = useWallets({ enabled: open });
  const { agents } = useAllAgents({ enabled: open });

  /**
   * The index the seller would have signed, resolved from our own registry copy
   * of the agent rather than assumed. Returns null when the agent is not in this
   * node's registry — a purchase from another organisation — and the caller then
   * falls back to 0 and surfaces the field for the operator to correct.
   */
  const cardanoIndexForAgent = useCallback(
    (agentIdentifier: string | null | undefined): number | null => {
      if (!agentIdentifier) return null;
      const match = buildPaidAgentOptions(agents, selectedPaymentSource?.paymentSourceType).find(
        (option) => option.agentIdentifier === agentIdentifier,
      );
      return match?.supportedPaymentSourceIndex ?? null;
    },
    [agents, selectedPaymentSource?.paymentSourceType],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [curlCommand, setCurlCommand] = useState<string>('');
  const [response, setResponse] = useState<PostPurchaseResponse['data'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBuyerWalletId, setSelectedBuyerWalletId] = useState<string>('');
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  const [extractedAmounts, setExtractedAmounts] = useState<
    Array<{ amount: string; unit: string }> | undefined
  >(undefined);
  // Seller-signed routing choice from the payment (paste/lookup). Non-null values
  // are part of the signed identifier and MUST be sent back on the purchase.
  const [paymentForceLayer, setPaymentForceLayer] = useState<'L1' | 'Hydra' | null>(null);
  const [sellerReturnAddress, setSellerReturnAddress] = useState<string | null>(null);
  // Also signed into a V2 identifier, but not recoverable from any response —
  // see ExtractedPaymentFields. Editable so agents advertising more than one
  // Cardano source can select the one the seller actually priced against.
  const [supportedPaymentSourceIndex, setSupportedPaymentSourceIndex] = useState<number | null>(
    null,
  );
  // The buyer's own optional routing override ('Auto' omits the field).
  const [buyerForceLayer, setBuyerForceLayer] = useState<'Auto' | 'L1' | 'Hydra'>('Auto');

  const availableBuyerWallets = useMemo(
    () => wallets.filter((wallet) => wallet.type === 'Purchasing'),
    [wallets],
  );

  const selectedBuyerWallet = useMemo(
    () => availableBuyerWallets.find((wallet) => wallet.id === selectedBuyerWalletId) ?? null,
    [availableBuyerWallets, selectedBuyerWalletId],
  );

  useEffect(() => {
    if (!open) return;

    if (availableBuyerWallets.length === 0) {
      if (selectedBuyerWalletId) {
        setSelectedBuyerWalletId('');
      }
      return;
    }

    if (availableBuyerWallets.some((wallet) => wallet.id === selectedBuyerWalletId)) {
      return;
    }

    setSelectedBuyerWalletId(availableBuyerWallets[0].id);
  }, [open, availableBuyerWallets, selectedBuyerWalletId]);

  const handleWalletClick = useCallback(
    async (walletVkey: string) => {
      const found = await lookupWalletByVkey({
        apiClient,
        walletVkey,
        paymentSourceId: selectedPaymentSource?.id,
      });
      if (!found) {
        toast.error('Wallet not found in current payment sources');
        return;
      }
      setSelectedWalletForDetails(found);
    },
    [apiClient, selectedPaymentSource?.id],
  );

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

        setExtractedAmounts(undefined);
        setPaymentForceLayer(null);
        setSellerReturnAddress(null);
        setSupportedPaymentSourceIndex(null);
        return;
      }
      const result = tryExtractPaymentFields(value);
      if (result) {
        setPasteError(null);
        applyFields(result.formFields);

        setExtractedAmounts(result.amounts);
        setPaymentForceLayer(result.paymentForceLayer ?? null);
        setSellerReturnAddress(result.sellerReturnAddress ?? null);
        // Non-null marks the identifier as V2; resolve the real index from the
        // agent, falling back to 0 only when we have no registry entry for it.
        setSupportedPaymentSourceIndex(
          result.supportedPaymentSourceIndex == null
            ? null
            : (cardanoIndexForAgent(result.formFields.agentIdentifier) ?? 0),
        );
        if (result.formFields.identifierFromPurchaser) {
          toast.success('Fields populated from pasted response');
        } else {
          toast.error(
            'Could not decode the purchaser identifier from the blockchain identifier. Please enter it manually.',
          );
        }
      } else {
        setPasteError(
          'Could not extract payment data. Paste the JSON response from Create Payment.',
        );
        setExtractedAmounts(undefined);
      }
    },
    [applyFields, cardanoIndexForAgent],
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

        setExtractedAmounts(
          payment.RequestedFunds && payment.RequestedFunds.length > 0
            ? payment.RequestedFunds.map((f) => ({ amount: f.amount, unit: f.unit }))
            : undefined,
        );
        setPaymentForceLayer(payment.forceLayer ?? null);
        setSellerReturnAddress(payment.sellerReturnAddress ?? null);
        setSupportedPaymentSourceIndex(
          decoded?.smartContractAddress != null
            ? (cardanoIndexForAgent(payment.agentIdentifier) ?? 0)
            : null,
        );

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
          ...(extractedAmounts && extractedAmounts.length > 0 ? { Amounts: extractedAmounts } : {}),
          // Both of these are signed into the identifier and must be sent back
          // exactly as the seller set them, or the reconstructed payload will not
          // match and the purchase is rejected.
          ...(paymentForceLayer != null ? { paymentForceLayer } : {}),
          ...(sellerReturnAddress != null ? { sellerReturnAddress } : {}),
          ...(supportedPaymentSourceIndex != null ? { supportedPaymentSourceIndex } : {}),
          ...(buyerForceLayer !== 'Auto' ? { forceLayer: buyerForceLayer } : {}),
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
          // The lists behind this dialog describe the world before it ran.
          await resync('purchases');
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
    [
      resync,
      apiClient,
      apiKey,
      network,
      extractedAmounts,
      paymentForceLayer,
      sellerReturnAddress,
      supportedPaymentSourceIndex,
      buyerForceLayer,
    ],
  );

  const handleClose = () => {
    reset();
    setSelectedBuyerWalletId('');
    setPasteValue('');
    setPasteError(null);
    setExtractedAmounts(undefined);
    setPaymentForceLayer(null);
    setSellerReturnAddress(null);
    setSupportedPaymentSourceIndex(null);
    setBuyerForceLayer('Auto');
    setResponse(null);
    setError(null);
    setCurlCommand('');
    onClose();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent
          size="lg"
          className="h-[85vh] flex flex-col overflow-hidden"
          isPushedBack={!!selectedWalletForDetails}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>Create Test Purchase</DialogTitle>
            <p className="text-sm text-muted-foreground mt-2">
              Create a test purchase from a payment response or blockchain identifier.
            </p>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto min-h-0">
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
              {/* Buyer Wallet */}
              <Card className="animate-fade-in-up opacity-0 animate-stagger-1 transition-shadow duration-200 hover:shadow-md">
                <CardContent className="p-4 space-y-3">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">Buyer Wallet</Label>
                    <p className="text-xs text-muted-foreground">
                      Choose the purchasing wallet used as buyer context for this test flow.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedBuyerWalletId}
                      onValueChange={setSelectedBuyerWalletId}
                      disabled={availableBuyerWallets.length === 0}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue
                          placeholder={
                            availableBuyerWallets.length === 0
                              ? 'No purchasing wallets on selected payment source'
                              : 'Select buyer wallet'
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {availableBuyerWallets.map((wallet) => (
                          <SelectItem key={wallet.id} value={wallet.id}>
                            {shortenAddress(wallet.walletAddress, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={!selectedBuyerWallet}
                      onClick={() =>
                        selectedBuyerWallet && handleWalletClick(selectedBuyerWallet.walletVkey)
                      }
                      aria-label="Open buyer wallet details"
                    >
                      <Wallet className="h-4 w-4" />
                    </Button>
                    {selectedBuyerWallet && (
                      <CopyButton value={selectedBuyerWallet.walletAddress} />
                    )}
                  </div>
                  {availableBuyerWallets.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Add a purchasing wallet to the selected payment source to enable buyer wallet
                      selection.
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Paste Payment Response */}
              <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-2">
                <Label className="flex items-center gap-1.5">
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  Paste Payment Response
                </Label>
                <Textarea
                  value={pasteValue}
                  onChange={(e) => handlePasteResponse(e.target.value)}
                  placeholder="Paste the JSON response from Create Payment to auto-fill all fields..."
                  rows={4}
                  className={`font-mono text-xs transition-colors duration-200 ${pasteError ? 'border-destructive' : ''}`}
                />
                {pasteError && (
                  <p className="text-sm text-destructive animate-fade-in">{pasteError}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Or fill in the fields manually below.
                </p>
              </div>

              {/* Blockchain Identifier + Lookup */}
              <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-3">
                <Label>
                  Blockchain Identifier <span className="text-destructive">*</span>
                </Label>
                <div className="flex gap-2">
                  <Input
                    {...register('blockchainIdentifier')}
                    placeholder="Blockchain identifier"
                    className={`font-mono text-xs flex-1 transition-colors duration-200 ${errors.blockchainIdentifier ? 'border-destructive' : ''}`}
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
                  <p className="text-sm text-destructive animate-fade-in">
                    {errors.blockchainIdentifier.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Optionally click Lookup to resolve fields from the API. Only payments created
                  through this service will be found.
                </p>
              </div>

              {/* Payment Data Fields */}
              <Card className="animate-fade-in-up opacity-0 animate-stagger-4 transition-shadow duration-200 hover:shadow-md">
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-medium text-muted-foreground">Payment Data</p>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <div className="space-y-1.5 col-span-2">
                      <Label className="text-xs text-muted-foreground font-normal">
                        Agent Identifier <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('agentIdentifier')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.agentIdentifier ? 'border-destructive' : ''}`}
                        placeholder="Agent identifier"
                      />
                      {errors.agentIdentifier && (
                        <p className="text-xs text-destructive animate-fade-in">
                          {errors.agentIdentifier.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5 col-span-2">
                      <Label className="text-xs text-muted-foreground font-normal">
                        Purchaser Identifier <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('identifierFromPurchaser')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.identifierFromPurchaser ? 'border-destructive' : ''}`}
                        placeholder="Purchaser identifier"
                      />
                      {errors.identifierFromPurchaser && (
                        <p className="text-xs text-destructive animate-fade-in">
                          {errors.identifierFromPurchaser.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground font-normal">
                        Seller VKey <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('sellerVkey')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.sellerVkey ? 'border-destructive' : ''}`}
                        placeholder="Seller verification key"
                      />
                      {errors.sellerVkey && (
                        <p className="text-xs text-destructive animate-fade-in">
                          {errors.sellerVkey.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground font-normal">
                        Input Hash <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('inputHash')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.inputHash ? 'border-destructive' : ''}`}
                        placeholder="Input hash"
                      />
                      {errors.inputHash && (
                        <p className="text-xs text-destructive animate-fade-in">
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
                        Pay By <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('payByTime')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.payByTime ? 'border-destructive' : ''}`}
                        placeholder="ISO date"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground font-normal">
                        Submit Result <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('submitResultTime')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.submitResultTime ? 'border-destructive' : ''}`}
                        placeholder="ISO date"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground font-normal">
                        Unlock <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('unlockTime')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.unlockTime ? 'border-destructive' : ''}`}
                        placeholder="ISO date"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground font-normal">
                        External Dispute Unlock <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        {...register('externalDisputeUnlockTime')}
                        className={`font-mono text-xs transition-colors duration-200 ${errors.externalDisputeUnlockTime ? 'border-destructive' : ''}`}
                        placeholder="ISO date"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Metadata */}
              <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-5">
                <Label>Metadata (Optional)</Label>
                <Textarea
                  {...register('metadata')}
                  placeholder="Optional metadata for the purchase"
                  rows={2}
                  className="resize-none"
                />
              </div>

              {/* Layer Routing (forceLayer) */}
              <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-5">
                <Label>Layer Routing</Label>
                <Select
                  value={buyerForceLayer}
                  onValueChange={(value) => setBuyerForceLayer(value as 'Auto' | 'L1' | 'Hydra')}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Auto (recommended)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Auto">Auto (recommended)</SelectItem>
                    <SelectItem value="L1">Force L1</SelectItem>
                    <SelectItem value="Hydra">Force Hydra (Beta)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {paymentForceLayer != null
                    ? `The seller signed "${paymentForceLayer === 'Hydra' ? 'Force Hydra' : 'Force L1'}" into the payment terms; it is sent automatically and your choice must not conflict with it.`
                    : 'Auto uses Hydra when an open head is available, otherwise L1. Force Hydra fails the funds-lock instead of falling back to L1.'}
                </p>
              </div>

              {/* supportedPaymentSourceIndex — signed into V2 identifiers but not
                  returned by any endpoint, so it is defaulted rather than read back. */}
              {supportedPaymentSourceIndex != null && (
                <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-5">
                  <Label htmlFor="supportedPaymentSourceIndex">
                    Supported Payment Source Index
                  </Label>
                  <Input
                    id="supportedPaymentSourceIndex"
                    type="number"
                    min={0}
                    max={24}
                    value={supportedPaymentSourceIndex}
                    onChange={(e) => {
                      const next = Number.parseInt(e.target.value, 10);
                      setSupportedPaymentSourceIndex(Number.isNaN(next) ? 0 : next);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    The seller signed this into the payment terms and it must be sent back
                    unchanged. No endpoint returns it, so it is resolved from this node&apos;s
                    registry copy of the agent. If the agent is not registered here — a purchase
                    from another organisation — it falls back to 0, which is only right when the
                    agent&apos;s Cardano source is the first entry it advertises; x402/EVM entries
                    occupy indexes too. A wrong value is rejected as &quot;does not select a Cardano
                    payment source&quot;.
                  </p>
                </div>
              )}

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
      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
        isChild
      />
    </>
  );
}
