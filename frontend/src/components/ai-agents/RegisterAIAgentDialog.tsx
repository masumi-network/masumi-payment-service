import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postRegistry, postRegistryUpdate, RegistryEntry } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { getActiveStablecoinConfig } from '@/lib/constants/defaultWallets';
import { useWallets } from '@/lib/queries/useWallets';
import type { WalletListItem } from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { findX402ValidationError } from '@/lib/x402-registration';
import {
  buildAgentMetadataPayload,
  buildEvmSupportedSources,
  buildMasumiSupportedSources,
  buildOrderedSupportedPaymentSources,
  buildPaymentOptionPrefill,
  storedAmountToDecimal,
  mapStoredUnitToPriceOption,
  validateMasumiOptions,
  type CardanoSupportedSource,
} from '@/lib/agent-registration';
import {
  VerificationsSection,
  validateVerifications,
  verificationsFromApi,
  verificationsToApi,
  type VerificationDraft,
} from './VerificationsSection';
import { getPrimaryCardanoPricing } from '@/lib/registry-pricing';
import {
  createAgentSchema,
  createAgentDefaultValues,
  type AgentFormValues,
} from './register-agent-schema';
import { usePaymentOptions } from './usePaymentOptions';
import { PaymentOptionsSection } from './PaymentOptionsSection';
import { RegisterAgentDetailsSection } from './RegisterAgentDetailsSection';
import { RegisterAgentWalletSection } from './RegisterAgentWalletSection';
import { RegisterAgentAdditionalSection } from './RegisterAgentAdditionalSection';

interface RegisterAIAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * When set, the dialog operates in update mode for the given agent: the
   * form pre-fills with the agent's current metadata, the selling wallet
   * picker is hidden (the asset's current managed holder signs the update),
   * and submission calls the V2 update endpoint. Leave undefined for the
   * default register flow.
   */
  editingAgent?: RegistryEntry | null;
  /**
   * Smart contract address of the payment source `editingAgent` belongs to.
   * Threaded through to the update call so the V2 lookup hits the right
   * source (the backend default fallback resolves to V1). Required when
   * `editingAgent` is provided.
   */
  editingAgentSmartContractAddress?: string;
  /**
   * When set (and `editingAgent` is not), the dialog operates in re-register
   * mode: it pre-fills from the given agent exactly like update mode, but
   * stays a fresh registration — the minting-wallet picker is shown and
   * submission calls the register endpoint, minting a BRAND-NEW asset with a
   * NEW agent identifier on the active payment source. Used to re-register a
   * previously deregistered agent.
   */
  prefillAgent?: RegistryEntry | null;
  /** Stack above an elevated parent (e.g. opened from the agent details dialog). */
  elevatedChildStack?: boolean;
}

const MIN_MINT_BALANCE_LOVELACE = 3000000;

export function RegisterAIAgentDialog({
  open,
  onClose,
  onSuccess,
  editingAgent,
  editingAgentSmartContractAddress,
  prefillAgent,
  elevatedChildStack,
}: RegisterAIAgentDialogProps) {
  const isUpdateMode = !!editingAgent;
  // Re-register: prefill from an existing (deregistered) agent but mint a
  // fresh registration. Never both — editingAgent takes precedence.
  const isReRegisterMode = !isUpdateMode && !!prefillAgent;
  const sourceAgent = editingAgent ?? prefillAgent ?? null;
  const [isLoading, setIsLoading] = useState(false);
  // Author/legal/capability/example-output fields are all optional, so collapse
  // them by default to shorten the form; auto-expand when editing/re-registering
  // an existing agent (below) so its saved values are visible.
  const [showAdditional, setShowAdditional] = useState(false);
  const [sellingWallets, setSellingWallets] = useState<
    { wallet: WalletListItem; balance: number }[]
  >([]);

  const { wallets, isLoading: isLoadingWallets, isError: isWalletsError } = useWallets();
  const { apiClient, network, selectedPaymentSource } = useAppContext();
  // x402 and source-owned pricing are V2-only; update always targets V2.
  const isV2Target = isUpdateMode
    ? true
    : !!selectedPaymentSource && isV2PaymentSource(selectedPaymentSource);
  const stablecoinUnit = network === 'Mainnet' ? 'USDCx' : 'tUSDM';
  // V2 treats every advertised payment source as a peer. Start fixed pricing
  // with the network stablecoin instead of implying that ADA is mandatory.
  const defaultPriceUnit =
    selectedPaymentSource && isV2PaymentSource(selectedPaymentSource) ? stablecoinUnit : 'lovelace';

  const {
    register,
    handleSubmit,
    control,
    setValue,
    reset,
    formState: { errors },
    watch,
  } = useForm<AgentFormValues>({
    resolver: zodResolver(createAgentSchema(network)),
    defaultValues: {
      ...createAgentDefaultValues(defaultPriceUnit),
      ...(isV2Target ? { prices: [], pricingType: 'Dynamic' as const } : {}),
    },
  });

  const {
    fields: priceFields,
    append: appendPrice,
    remove: removePrice,
    replace: replacePrices,
  } = useFieldArray({
    control,
    name: 'prices',
  });

  const {
    fields: exampleOutputFields,
    append: appendExampleOutput,
    remove: removeExampleOutput,
  } = useFieldArray({
    control,
    name: 'exampleOutputs',
  });

  const selectedWalletVkey = watch('selectedWallet');
  const selectedRecipientWalletAddress = watch('recipientWalletAddress');
  const selectedSendFundingAda = watch('sendFundingAda');
  useEffect(() => {
    setSellingWallets(
      wallets
        .filter((w) => w.type === 'Selling')
        .map((w) => ({
          wallet: {
            id: w.id,
            paymentSourceId: w.paymentSourceId,
            type: w.type,
            walletVkey: w.walletVkey,
            walletAddress: w.walletAddress,
            collectionAddress: w.collectionAddress,
            note: w.note,
            LowBalanceSummary: w.LowBalanceSummary,
          },
          balance: parseInt(w.balance, 10),
        })),
    );
  }, [wallets]);

  // Reset the V1 legacy top-level pricing form when a payment-option row
  // changes type (per-option pricing is V2-only).
  const setLegacyPricingMode = useCallback(
    (mode: 'Fixed' | 'Dynamic') => {
      setValue('pricingType', mode);
      replacePrices(mode === 'Fixed' ? [{ unit: defaultPriceUnit, amount: '' }] : []);
    },
    [setValue, replacePrices, defaultPriceUnit],
  );

  const {
    masumiOptions,
    x402Options,
    paymentOptionRows,
    masumiError,
    x402Error,
    setMasumiError,
    setX402Error,
    x402Networks,
    x402Wallets,
    isLoadingX402Wallets,
    addPaymentOption,
    changePaymentOptionType,
    removePaymentOption,
    changeMasumiOption,
    changeX402Option,
    applyPrefill,
    resetOptions,
  } = usePaymentOptions({
    open,
    isV2Target,
    defaultPriceUnit,
    setLegacyPricingMode,
  });

  const [verifications, setVerifications] = useState<VerificationDraft[]>([]);
  const [verificationsError, setVerificationsError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Expanded when there's an agent to review (update/re-register), collapsed
    // for a fresh registration.
    setShowAdditional(Boolean(sourceAgent));
    if (sourceAgent) {
      const editingAgent = sourceAgent;
      const stablecoinFullAssetId = getActiveStablecoinConfig(network).fullAssetId;
      const editingPricing = getPrimaryCardanoPricing(editingAgent) ?? {
        pricingType: 'Free' as const,
      };
      reset({
        agentType: editingAgent.type ?? 'Standard',
        apiUrl: editingAgent.apiBaseUrl ?? '',
        openApiSpecUrl: editingAgent.openApiSpecUrl ?? '',
        x402ResourcesUrl: editingAgent.x402ResourcesUrl ?? '',
        name: editingAgent.name,
        description: editingAgent.description ?? '',
        // Selling wallet is fixed in update mode — the asset's managed
        // holder signs the UpdateAction; the picker is hidden below.
        selectedWallet: editingAgent.SmartContractWallet?.walletVkey ?? '',
        recipientWalletAddress: editingAgent.RecipientWallet?.walletAddress ?? '',
        sendFundingAda: editingAgent.sendFundingLovelace
          ? storedAmountToDecimal(editingAgent.sendFundingLovelace)
          : '',
        prices:
          !isV2Target && editingPricing.pricingType === 'Fixed'
            ? editingPricing.Pricing.map((p) => ({
                unit: mapStoredUnitToPriceOption(p.unit, stablecoinUnit, stablecoinFullAssetId),
                amount: storedAmountToDecimal(p.amount),
              }))
            : [],
        tags: editingAgent.Tags ?? [],
        pricingType: isV2Target ? 'Dynamic' : editingPricing.pricingType,
        authorName: editingAgent.Author.name,
        authorEmail: editingAgent.Author.contactEmail ?? '',
        organization: editingAgent.Author.organization ?? '',
        contactOther: editingAgent.Author.contactOther ?? '',
        termsOfUseUrl: editingAgent.Legal.terms ?? '',
        privacyPolicyUrl: editingAgent.Legal.privacyPolicy ?? '',
        otherUrl: editingAgent.Legal.other ?? '',
        capabilityName: editingAgent.Capability.name ?? '',
        capabilityVersion: editingAgent.Capability.version ?? '',
        exampleOutputs: (editingAgent.ExampleOutputs ?? []).map((e) => ({
          name: e.name,
          url: e.url,
          mimeType: e.mimeType,
        })),
      });
      // Stored sources map to option drafts in stored order, keeping each
      // Cardano source's own escrow address and original index so an update
      // resubmits exactly what is registered (no silent re-pointing or
      // reordering).
      applyPrefill(
        buildPaymentOptionPrefill({
          supportedPaymentSources: editingAgent.supportedPaymentSources,
          legacyPricing: editingPricing,
          stablecoinUnit,
          stablecoinFullAssetId,
        }),
      );
      setVerifications(verificationsFromApi(editingAgent.verifications));
      setVerificationsError(null);
      return;
    }
    reset({
      ...createAgentDefaultValues(defaultPriceUnit),
      ...(isV2Target ? { prices: [], pricingType: 'Dynamic' as const } : {}),
    });
    resetOptions();
    setVerifications([]);
    setVerificationsError(null);
  }, [
    applyPrefill,
    defaultPriceUnit,
    isV2Target,
    open,
    reset,
    resetOptions,
    sourceAgent,
    network,
    stablecoinUnit,
  ]);

  const selectedWallet = useMemo(
    () => sellingWallets.find((wallet) => wallet.wallet.walletVkey === selectedWalletVkey),
    [sellingWallets, selectedWalletVkey],
  );
  // The chosen minting wallet always belongs to the active payment source
  // (the picker is scoped to it via useWallets), so its sibling holding wallets
  // are the other wallets returned for that source.
  const recipientWalletOptions = useMemo(
    () =>
      selectedWallet
        ? wallets.filter((wallet) => wallet.walletAddress !== selectedWallet.wallet.walletAddress)
        : [],
    [wallets, selectedWallet],
  );

  useEffect(() => {
    // Wallets drive recipientWalletOptions; while the wallets query is still
    // loading (or errored) the options are transiently empty, and reconciling
    // against them would wipe the prefilled holding wallet + funding override
    // in update mode. Only reconcile once wallets have actually loaded.
    if (isLoadingWallets || isWalletsError) return;
    if (!selectedRecipientWalletAddress) {
      if (selectedSendFundingAda) {
        setValue('sendFundingAda', '');
      }
      return;
    }

    const isRecipientStillAvailable = recipientWalletOptions.some(
      (wallet) => wallet.walletAddress === selectedRecipientWalletAddress,
    );
    if (!isRecipientStillAvailable) {
      setValue('recipientWalletAddress', '');
    }
  }, [
    isLoadingWallets,
    isWalletsError,
    recipientWalletOptions,
    selectedRecipientWalletAddress,
    selectedSendFundingAda,
    setValue,
  ]);

  const onSubmit = useCallback(
    async (data: AgentFormValues) => {
      try {
        setIsLoading(true);
        const selectedWalletVkey = data.selectedWallet;
        // Register requires the user to pick a wallet with funds. Update
        // is signed by whatever managed wallet currently holds the
        // asset, so the picker is hidden and the balance gate is skipped
        // — the backend / scheduler will surface a meaningful error if
        // the holder wallet is under-funded.
        if (!isUpdateMode) {
          const selectedWalletBalance = sellingWallets.find(
            (w) => w.wallet.walletVkey == selectedWalletVkey,
          )?.balance;
          if (
            selectedWalletBalance == undefined ||
            selectedWalletBalance <= MIN_MINT_BALANCE_LOVELACE
          ) {
            toast.error('Insufficient balance in selected wallet');
            return;
          }
          // The picker only offers wallets from the active payment source, so a
          // picked wallet implies the source is present.
          if (!selectedPaymentSource) {
            toast.error('Smart contract wallet not found in payment sources');
            return;
          }
        }

        const stablecoinAsset = getActiveStablecoinConfig(network).fullAssetId;
        const { legal, author, capability, agentPricing, exampleOutputs, sendFundingLovelace } =
          buildAgentMetadataPayload(data, stablecoinUnit, stablecoinAsset);

        // Dialog row order = the payment-option numbering the operator sees.
        const rowIndexById = new Map(paymentOptionRows.map((row, index) => [row.id, index]));

        let masumiPricingByOptionId = new Map<string, CardanoSupportedSource['pricing']>();
        if (isV2Target) {
          const masumiValidation = validateMasumiOptions({
            masumiOptions,
            optionNumberById: new Map(paymentOptionRows.map((row, index) => [row.id, index + 1])),
            stablecoinUnit,
            stablecoinAsset,
          });
          if ('error' in masumiValidation) {
            setMasumiError(masumiValidation.error);
            toast.error(masumiValidation.error.message);
            return;
          }
          masumiPricingByOptionId = masumiValidation.pricingByOptionId;
        }
        setMasumiError(null);

        const evmSupportedSources = buildEvmSupportedSources(x402Options);
        if (!isV2Target && x402Options.length > 0) {
          const unavailableMessage =
            'x402 payment options require an active Web3 Cardano V2 payment source';
          setX402Error({ message: unavailableMessage });
          toast.error(unavailableMessage);
          return;
        }
        if (x402Options.length > 0) {
          // Label errors with the dialog's overall payment-option numbering
          // (Masumi and x402 rows interleave) instead of the x402-only index.
          const x402Labels = x402Options.map((option) => {
            const rowIndex = rowIndexById.get(option.id);
            return rowIndex != null ? `Payment option ${rowIndex + 1}` : undefined;
          });
          const x402ValidationError = findX402ValidationError(x402Options, x402Labels);
          if (x402ValidationError) {
            setX402Error({
              message: x402ValidationError.message,
              optionId: x402Options[x402ValidationError.index]?.id,
            });
            toast.error(x402ValidationError.message);
            return;
          }
        }
        setX402Error(null);
        if (isV2Target && verifications.length > 0) {
          const verificationsValidationError = validateVerifications(verifications);
          if (verificationsValidationError) {
            setVerificationsError(verificationsValidationError);
            toast.error(verificationsValidationError);
            return;
          }
        }
        setVerificationsError(null);

        if (isUpdateMode && editingAgent) {
          if (!editingAgent.agentIdentifier) {
            throw new Error('Cannot update agent: Missing on-chain identifier');
          }
          if (!editingAgentSmartContractAddress) {
            throw new Error('Cannot update agent: Missing payment source address');
          }
          // Each prefilled option keeps the escrow address of the stored
          // source it came from; only newly added options fall back to the
          // editing source's address. Stored on-chain ordering is preserved
          // for surviving options, with new options appended at the end.
          const masumiSupportedSources = buildMasumiSupportedSources({
            masumiOptions,
            pricingByOptionId: masumiPricingByOptionId,
            network,
            fallbackAddress: editingAgentSmartContractAddress,
          });
          const supportedPaymentSources = buildOrderedSupportedPaymentSources({
            masumiOptions,
            masumiSources: masumiSupportedSources,
            x402Options,
            evmSources: evmSupportedSources,
            rowIndexById,
          });
          const updateResponse = await postRegistryUpdate({
            client: apiClient,
            body: {
              agentIdentifier: editingAgent.agentIdentifier,
              network,
              smartContractAddress: editingAgentSmartContractAddress,
              recipientWalletAddress: data.recipientWalletAddress || undefined,
              sendFundingLovelace,
              name: data.name,
              description: data.description,
              // Update route is Standard-only for now (type-aware update is a
              // backend follow-up); apiUrl is populated for existing entries.
              apiBaseUrl: data.apiUrl || undefined,
              Tags: data.tags,
              Capability: capability,
              Author: author,
              Legal: legal,
              ExampleOutputs: exampleOutputs,
              supportedPaymentSources,
              // Update is V2-only (isV2Target is forced true above) and the
              // form's `verifications` state is the authoritative user-facing
              // list (loaded from the agent on open). Always send it so the
              // backend mirrors exactly what the user sees — sending `[]`
              // clears stored rows. Gating on a derived `hadVerifications`
              // flag would silently keep stale rows when the list API returns
              // `verifications: null` for rows it dropped as malformed.
              verifications: verificationsToApi(verifications),
            },
          });

          // The generated client returns {data, error} and never throws —
          // surface the real backend error instead of the generic fallback.
          if (updateResponse.error || !updateResponse.data?.data?.id) {
            throw new Error(
              extractApiErrorMessage(
                updateResponse.error,
                'Failed to update AI agent: Invalid response from server',
              ),
            );
          }

          toast.success('AI agent update requested');
          onSuccess();
          onClose();
          reset();
          return;
        }

        const activeMasumiAddress = selectedPaymentSource?.smartContractAddress;
        if (isV2Target && masumiOptions.length > 0 && !activeMasumiAddress) {
          throw new Error('Cannot register agent: Missing active Masumi payment source address');
        }
        // A register (including re-register) mints a fresh asset on the
        // ACTIVE payment source, so every Masumi option advertises the active
        // source's escrow address — stored addresses from a prefill belong to
        // the old registration and are intentionally dropped here.
        const registerMasumiOptions = masumiOptions.map(
          ({ address: _address, ...option }) => option,
        );
        const masumiSupportedSources: CardanoSupportedSource[] =
          isV2Target && activeMasumiAddress
            ? buildMasumiSupportedSources({
                masumiOptions: registerMasumiOptions,
                pricingByOptionId: masumiPricingByOptionId,
                network,
                fallbackAddress: activeMasumiAddress,
              })
            : [];
        const supportedPaymentSources = buildOrderedSupportedPaymentSources({
          masumiOptions: registerMasumiOptions,
          masumiSources: masumiSupportedSources,
          x402Options,
          evmSources: evmSupportedSources,
          rowIndexById,
        });
        const response = await postRegistry({
          client: apiClient,
          body: {
            network: network,
            sellingWalletVkey: selectedWalletVkey,
            recipientWalletAddress: data.recipientWalletAddress || undefined,
            sendFundingLovelace,
            name: data.name,
            description: data.description,
            // Endpoint descriptor is per agent type; payment is a separate axis.
            type: data.agentType,
            ...(data.agentType === 'Standard' ? { apiBaseUrl: data.apiUrl } : {}),
            ...(data.agentType === 'OpenApi' ? { openApiSpecUrl: data.openApiSpecUrl } : {}),
            ...(data.agentType === 'X402' ? { x402ResourcesUrl: data.x402ResourcesUrl } : {}),
            Tags: data.tags,
            Capability: capability,
            Author: author,
            Legal: legal,
            ExampleOutputs: exampleOutputs,
            ...(isV2Target ? { supportedPaymentSources } : { AgentPricing: agentPricing }),
            ...(isV2Target && verifications.length > 0
              ? { verifications: verificationsToApi(verifications) }
              : {}),
          },
        });

        // The generated client returns {data, error} and never throws —
        // surface the real backend error instead of the generic fallback.
        if (response.error || !response.data?.data?.id) {
          throw new Error(
            extractApiErrorMessage(
              response.error,
              'Failed to register AI agent: Invalid response from server',
            ),
          );
        }

        toast.success(
          isReRegisterMode
            ? 'AI agent re-registration requested (a new identifier will be minted)'
            : 'AI agent registered successfully',
        );
        onSuccess();
        onClose();
        reset();
      } catch (error: unknown) {
        console.error('Error registering AI agent:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to register AI agent');
      } finally {
        setIsLoading(false);
      }
    },
    [
      sellingWallets,
      selectedPaymentSource,
      apiClient,
      network,
      stablecoinUnit,
      onSuccess,
      onClose,
      reset,
      isUpdateMode,
      isReRegisterMode,
      editingAgent,
      editingAgentSmartContractAddress,
      x402Options,
      masumiOptions,
      paymentOptionRows,
      verifications,
      isV2Target,
      setMasumiError,
      setX402Error,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent size="lg" className="overflow-y-auto" elevatedChildStack={elevatedChildStack}>
        <DialogHeader>
          <DialogTitle>
            {isUpdateMode
              ? 'Update AI Agent'
              : isReRegisterMode
                ? 'Re-register AI Agent'
                : 'Register AI Agent'}
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {isUpdateMode
              ? 'Updating the on-chain metadata issues an UpdateAction on the V2 registry contract: the existing asset is burned and a new asset with the incremented version is minted in a single transaction.'
              : isReRegisterMode
                ? 'This mints a brand-new registration from the previous agent’s details. It will be issued a new agent identifier — the old, deregistered one is not reused. Review the fields and wallet below, then mint.'
                : 'This registers your agent on the Masumi Network, making it visible to everyone.'}
          </p>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <RegisterAgentDetailsSection
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
            typeLocked={isUpdateMode}
          />

          <RegisterAgentWalletSection
            isUpdateMode={isUpdateMode}
            editingAgentWalletAddress={editingAgent?.SmartContractWallet?.walletAddress}
            control={control}
            errors={errors}
            register={register}
            isLoadingWallets={isLoadingWallets}
            sellingWallets={sellingWallets}
            hasSelectedWallet={!!selectedWallet}
            recipientWalletOptions={recipientWalletOptions}
            selectedRecipientWalletAddress={selectedRecipientWalletAddress}
          />

          <PaymentOptionsSection
            rows={paymentOptionRows}
            masumiOptions={masumiOptions}
            x402Options={x402Options}
            masumiError={masumiError}
            x402Error={x402Error}
            isV2Target={isV2Target}
            network={network}
            stablecoinUnit={stablecoinUnit}
            defaultPriceUnit={defaultPriceUnit}
            x402Networks={x402Networks}
            x402Wallets={x402Wallets}
            isLoadingX402Wallets={isLoadingX402Wallets}
            onAddOption={addPaymentOption}
            onChangeOptionType={changePaymentOptionType}
            onRemoveOption={removePaymentOption}
            onMasumiOptionChange={changeMasumiOption}
            onX402OptionChange={changeX402Option}
            control={control}
            watch={watch}
            errors={errors}
            register={register}
            priceFields={priceFields}
            appendPrice={appendPrice}
            removePrice={removePrice}
            replacePrices={replacePrices}
          />

          {isV2Target && (
            <VerificationsSection
              verifications={verifications}
              onChange={setVerifications}
              error={verificationsError}
            />
          )}

          <RegisterAgentAdditionalSection
            show={showAdditional}
            onToggle={() => setShowAdditional((v) => !v)}
            register={register}
            errors={errors}
            exampleOutputFields={exampleOutputFields}
            appendExampleOutput={appendExampleOutput}
            removeExampleOutput={removeExampleOutput}
          />

          <div className="flex justify-end items-center gap-2">
            <Button variant="outline" onClick={onClose} type="button">
              Cancel
            </Button>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={isLoading || (isLoadingWallets && !isUpdateMode)}>
                {isLoading
                  ? isUpdateMode
                    ? 'Updating...'
                    : isReRegisterMode
                      ? 'Re-registering...'
                      : 'Registering...'
                  : isUpdateMode
                    ? 'Update'
                    : isReRegisterMode
                      ? 'Re-register'
                      : 'Register'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
