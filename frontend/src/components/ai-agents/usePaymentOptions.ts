import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useAvailableX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { defaultX402Option, type X402OptionDraft } from '@/lib/x402-registration';
import {
  createMasumiOption,
  MASUMI_PAYMENT_OPTION_ID,
  MAX_PAYMENT_OPTIONS,
  type MasumiOptionDraft,
  type MasumiPriceUnit,
  type PaymentConfigurationType,
  type PaymentOptionPrefill,
  type PaymentOptionRow,
} from '@/lib/agent-registration';

export type PaymentOptionError = {
  message: string;
  optionId?: string;
} | null;

/**
 * State + handlers for the register/update dialog's payment-option rows
 * (Masumi and x402 drafts, row ordering, option-scoped validation errors,
 * and the one-shot x402 autofill). The dialog owns the V1 legacy top-level
 * pricing form; `setLegacyPricingMode` lets row-type changes reset it.
 */
export function usePaymentOptions(args: {
  open: boolean;
  isV2Target: boolean;
  defaultPriceUnit: MasumiPriceUnit;
  setLegacyPricingMode: (mode: 'Fixed' | 'Dynamic') => void;
}) {
  const { open, isV2Target, defaultPriceUnit, setLegacyPricingMode } = args;
  const { selectedX402ChainId } = useAppContext();

  const [x402Options, setX402Options] = useState<X402OptionDraft[]>([]);
  const [x402Error, setX402Error] = useState<PaymentOptionError>(null);
  const [paymentOptionRows, setPaymentOptionRows] = useState<PaymentOptionRow[]>([
    { id: MASUMI_PAYMENT_OPTION_ID, type: 'Masumi' },
  ]);
  const [masumiOptions, setMasumiOptions] = useState<MasumiOptionDraft[]>(() => [
    createMasumiOption(defaultPriceUnit, MASUMI_PAYMENT_OPTION_ID),
  ]);
  const [masumiError, setMasumiError] = useState<PaymentOptionError>(null);
  const { networks: x402Networks } = useAvailableX402Networks({ silentErrors: true });
  const { wallets: x402Wallets, isLoading: isLoadingX402Wallets } = useX402Wallets(open, 'Selling');

  // Options that already went through the one-shot autofill below. Without this
  // guard the effect would re-run on every wallets-query refresh and stomp
  // fields the user deliberately cleared (e.g. "Custom EVM address" empties
  // payTo). Ids are fresh per dialog session, so stale entries are harmless.
  const autofilledOptionIds = useRef(new Set<string>());

  useEffect(() => {
    if (x402Networks.length === 0 || isLoadingX402Wallets) return;

    setX402Options((currentOptions) => {
      let hasChanges = false;
      const nextOptions = currentOptions.map((option) => {
        if (autofilledOptionIds.current.has(option.id)) return option;
        autofilledOptionIds.current.add(option.id);
        if (option.caip2Network && option.payTo) return option;

        const defaults = defaultX402Option(x402Networks, x402Wallets, selectedX402ChainId);
        const nextOption = {
          ...option,
          caip2Network: option.caip2Network || defaults.caip2Network,
          asset: option.asset || (option.pricingType === 'Fixed' ? defaults.asset : ''),
          decimals:
            option.asset || option.pricingType !== 'Fixed' ? option.decimals : defaults.decimals,
          payTo: option.payTo || defaults.payTo,
        };
        hasChanges =
          hasChanges ||
          nextOption.caip2Network !== option.caip2Network ||
          nextOption.asset !== option.asset ||
          nextOption.decimals !== option.decimals ||
          nextOption.payTo !== option.payTo;
        return nextOption;
      });
      return hasChanges ? nextOptions : currentOptions;
    });
  }, [isLoadingX402Wallets, selectedX402ChainId, x402Networks, x402Wallets]);

  // New options are born with live defaults when networks and wallets are
  // already loaded, so mark them autofilled immediately; otherwise leave them
  // for the one-shot effect above to complete once the data arrives.
  const createX402Option = () => {
    const option = defaultX402Option(x402Networks, x402Wallets, selectedX402ChainId);
    if (x402Networks.length > 0 && !isLoadingX402Wallets) {
      autofilledOptionIds.current.add(option.id);
    }
    return option;
  };

  const addPaymentOption = () => {
    if (paymentOptionRows.length >= MAX_PAYMENT_OPTIONS) return;
    // New rows are x402 rows, which only V2 registrations can submit; the
    // add button is disabled for V1, this guard is defense-in-depth.
    if (!isV2Target) return;
    const option = createX402Option();
    setX402Options((currentOptions) => [...currentOptions, option]);
    setPaymentOptionRows((currentRows) => [...currentRows, { id: option.id, type: 'x402' }]);
    setX402Error(null);
  };

  const changePaymentOptionType = (
    optionRow: PaymentOptionRow,
    nextType: PaymentConfigurationType,
  ) => {
    if (optionRow.type === nextType) return;

    if (nextType === 'Masumi') {
      setX402Options((currentOptions) =>
        currentOptions.filter((option) => option.id !== optionRow.id),
      );
      const option = createMasumiOption(defaultPriceUnit);
      setMasumiOptions((currentOptions) => [...currentOptions, option]);
      setPaymentOptionRows((currentRows) =>
        currentRows.map((row) =>
          row.id === optionRow.id ? { id: option.id, type: 'Masumi' } : row,
        ),
      );
      if (!isV2Target) {
        setLegacyPricingMode('Fixed');
      }
      setX402Error(null);
      setMasumiError(null);
      return;
    }

    const option = createX402Option();
    setMasumiOptions((currentOptions) =>
      currentOptions.filter((candidate) => candidate.id !== optionRow.id),
    );
    setX402Options((currentOptions) => [...currentOptions, option]);
    setPaymentOptionRows((currentRows) =>
      currentRows.map((row) => (row.id === optionRow.id ? { id: option.id, type: 'x402' } : row)),
    );
    setLegacyPricingMode('Dynamic');
    setX402Error(null);
  };

  const removePaymentOption = (optionRow: PaymentOptionRow) => {
    if (paymentOptionRows.length === 1) return;

    setPaymentOptionRows((currentRows) => currentRows.filter((row) => row.id !== optionRow.id));
    if (optionRow.type === 'x402') {
      setX402Options((currentOptions) =>
        currentOptions.filter((option) => option.id !== optionRow.id),
      );
      setX402Error(null);
      return;
    }

    setMasumiOptions((currentOptions) =>
      currentOptions.filter((option) => option.id !== optionRow.id),
    );
    setMasumiError(null);
    if (!isV2Target) {
      setLegacyPricingMode('Dynamic');
    }
  };

  const changeMasumiOption = (nextOption: MasumiOptionDraft) => {
    setMasumiOptions((currentOptions) =>
      currentOptions.map((option) => (option.id === nextOption.id ? nextOption : option)),
    );
    setMasumiError(null);
  };

  const changeX402Option = (optionId: string, patch: Partial<X402OptionDraft>) => {
    setX402Options((currentOptions) =>
      currentOptions.map((option) => (option.id === optionId ? { ...option, ...patch } : option)),
    );
    setX402Error(null);
  };

  // Load an existing registration's option drafts (update / re-register).
  const applyPrefill = useCallback((prefill: PaymentOptionPrefill) => {
    setMasumiOptions(prefill.masumiOptions);
    setX402Options(prefill.x402Options);
    setPaymentOptionRows(prefill.paymentOptionRows);
    setX402Error(null);
    // The first Masumi row reuses the constant id across dialog sessions, so a
    // stale option-scoped banner would resurface on reopen without this reset.
    setMasumiError(null);
  }, []);

  // Fresh-registration defaults: a single empty Masumi row.
  const resetOptions = useCallback(() => {
    applyPrefill({
      masumiOptions: [createMasumiOption(defaultPriceUnit, MASUMI_PAYMENT_OPTION_ID)],
      x402Options: [],
      paymentOptionRows: [{ id: MASUMI_PAYMENT_OPTION_ID, type: 'Masumi' }],
    });
  }, [applyPrefill, defaultPriceUnit]);

  return {
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
  };
}
