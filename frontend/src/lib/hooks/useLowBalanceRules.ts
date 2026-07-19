import { useState, useEffect, useCallback } from 'react';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  deleteWalletLowBalance,
  getWallet,
  patchWalletLowBalance,
  postWalletLowBalance,
} from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import { isHotWalletType } from '@/lib/wallet-type';
import {
  CARDANO_NATIVE_ASSET_UNIT_PATTERN,
  EMPTY_LOW_BALANCE_SUMMARY,
  getRuleAssetMeta,
  getRuleAssetMetaFromPreset,
  getThresholdInputFromRaw,
  parseThresholdInputToRaw,
  validateRuleTopupInput,
  type LowBalanceRule,
  type RuleAssetPreset,
  type RuleDraft,
  type WalletDetailsState,
  type WalletWithBalance,
} from '@/components/wallets/wallet-details-utils';

/**
 * Owns the wallet low-balance monitoring rules: fetch, per-rule drafts, and the
 * create/update/delete CRUD. Extracted verbatim from WalletDetailsDialog; the
 * screen keeps the presentational section and passes these values into it.
 */
export function useLowBalanceRules({
  wallet,
  invalidateWalletQueries,
}: {
  wallet: WalletWithBalance | null;
  invalidateWalletQueries: () => Promise<void>;
}) {
  const { apiClient, network } = useAppContext();
  const [isWalletDetailsLoading, setIsWalletDetailsLoading] = useState(false);
  const [walletDetails, setWalletDetails] = useState<WalletDetailsState | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, RuleDraft>>({});
  const [newRuleAssetPreset, setNewRuleAssetPreset] = useState<RuleAssetPreset>('lovelace');
  const [newRuleCustomAssetUnit, setNewRuleCustomAssetUnit] = useState('');
  const [newRuleThresholdInput, setNewRuleThresholdInput] = useState('');
  const [newRuleEnabled, setNewRuleEnabled] = useState(true);
  const [newRuleTopupEnabled, setNewRuleTopupEnabled] = useState(false);
  const [newRuleTopupAmountInput, setNewRuleTopupAmountInput] = useState('');
  const [mutatingRuleIds, setMutatingRuleIds] = useState<Set<string>>(new Set());
  const [isCreatingRule, setIsCreatingRule] = useState(false);
  const [pendingDeleteRule, setPendingDeleteRule] = useState<LowBalanceRule | null>(null);

  const refreshWalletDetails = useCallback(async () => {
    if (!wallet || !isHotWalletType(wallet.type)) {
      setWalletDetails(null);
      return;
    }

    // Bind the narrowed type: TS drops narrowing on `wallet.type` inside the
    // callback below, and the previous `as 'Purchasing' | 'Selling'` cast is
    // what let Funding wallets reach an endpoint that rejected them.
    const walletType = wallet.type;

    setIsWalletDetailsLoading(true);

    await handleApiCall(
      () =>
        getWallet({
          client: apiClient,
          query: {
            walletType,
            id: wallet.id,
          },
        }),
      {
        onSuccess: (response) => {
          const data = response.data?.data;
          if (data) {
            setWalletDetails({
              LowBalanceSummary: data.LowBalanceSummary ?? EMPTY_LOW_BALANCE_SUMMARY,
              LowBalanceRules: data.LowBalanceRules ?? [],
            });
          }
        },
        onError: (fetchError: unknown) => {
          setWalletDetails(null);
          toast.error(extractApiErrorMessage(fetchError, 'Failed to load wallet monitoring rules'));
        },
        onFinally: () => {
          setIsWalletDetailsLoading(false);
        },
        errorMessage: 'Failed to load wallet monitoring rules',
      },
    );
  }, [apiClient, wallet]);

  const updateRuleDraft = useCallback(
    (ruleId: string, updates: Partial<RuleDraft>) => {
      setRuleDrafts((prev) => {
        const currentRule = walletDetails?.LowBalanceRules.find((rule) => rule.id === ruleId);
        const currentDraft = prev[ruleId] ?? {
          thresholdInput: currentRule
            ? getThresholdInputFromRaw(currentRule.thresholdAmount, currentRule.assetUnit, network)
            : '',
          enabled: currentRule?.enabled ?? true,
          topupEnabled: currentRule?.topupEnabled ?? false,
          topupAmountInput:
            currentRule?.topupAmount != null
              ? getThresholdInputFromRaw(currentRule.topupAmount, currentRule.assetUnit, network)
              : '',
        };

        return {
          ...prev,
          [ruleId]: {
            ...currentDraft,
            ...updates,
          },
        };
      });
    },
    [network, walletDetails],
  );

  // Seeds the editable per-rule drafts from the freshly-loaded server rules.
  // `ruleDrafts` is interactive state (mutated by updateRuleDraft as the user
  // types), not pure derived state — this reset-on-load pattern shipped
  // lint-clean inline in WalletDetailsDialog; the rule only flags it here
  // because the setter is no longer wired to JSX in the same file.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!walletDetails) {
      setRuleDrafts({});
      return;
    }

    setRuleDrafts(
      Object.fromEntries(
        walletDetails.LowBalanceRules.map((rule) => [
          rule.id,
          {
            thresholdInput: getThresholdInputFromRaw(rule.thresholdAmount, rule.assetUnit, network),
            enabled: rule.enabled,
            topupEnabled: rule.topupEnabled,
            topupAmountInput:
              rule.topupAmount != null
                ? getThresholdInputFromRaw(rule.topupAmount, rule.assetUnit, network)
                : '',
          },
        ]),
      ),
    );
  }, [network, walletDetails]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const resetForNewWallet = useCallback(() => {
    setWalletDetails(null);
    setNewRuleAssetPreset('lovelace');
    setNewRuleCustomAssetUnit('');
    setNewRuleThresholdInput('');
    setNewRuleEnabled(true);
    setNewRuleTopupEnabled(false);
    setNewRuleTopupAmountInput('');
  }, []);

  const handleSaveLowBalanceRule = async (rule: LowBalanceRule) => {
    const draft = ruleDrafts[rule.id] ?? {
      thresholdInput: getThresholdInputFromRaw(rule.thresholdAmount, rule.assetUnit, network),
      enabled: rule.enabled,
      topupEnabled: rule.topupEnabled,
      topupAmountInput:
        rule.topupAmount != null
          ? getThresholdInputFromRaw(rule.topupAmount, rule.assetUnit, network)
          : '',
    };
    const rawThresholdAmount = parseThresholdInputToRaw(
      draft.thresholdInput,
      rule.assetUnit,
      network,
    );

    if (rawThresholdAmount == null) {
      const assetMeta = getRuleAssetMeta(rule.assetUnit, network);
      toast.error(
        assetMeta.decimals == null
          ? 'Threshold amount must be a whole number in raw on-chain units.'
          : `Threshold amount must be a valid ${assetMeta.label} value with up to ${assetMeta.decimals} decimals.`,
      );
      return;
    }

    // Funding wallets are sources, never targets. Force any legacy invalid
    // value off when the rule is next saved; the UI does not expose its toggle.
    const topupEnabled = wallet?.type !== 'Funding' && draft.topupEnabled;

    const topupValidation = validateRuleTopupInput({
      enabled: topupEnabled,
      topupAmountInput: draft.topupAmountInput,
      assetUnit: rule.assetUnit,
      network,
    });
    if (topupValidation.error) {
      toast.error(topupValidation.error);
      return;
    }

    setMutatingRuleIds((prev) => new Set(prev).add(rule.id));
    const response = await handleApiCall(
      () =>
        patchWalletLowBalance({
          client: apiClient,
          body: {
            ruleId: rule.id,
            thresholdAmount: rawThresholdAmount,
            enabled: draft.enabled,
            topupEnabled,
            topupAmount: topupEnabled ? topupValidation.rawTopupAmount : null,
          },
        }),
      {
        onError: (mutationError: unknown) => {
          toast.error(extractApiErrorMessage(mutationError, 'Failed to update low-balance rule'));
        },
        errorMessage: 'Failed to update low-balance rule',
      },
    );
    setMutatingRuleIds((prev) => {
      const next = new Set(prev);
      next.delete(rule.id);
      return next;
    });

    if (response) {
      toast.success('Low-balance rule updated');
      await refreshWalletDetails();
      await invalidateWalletQueries();
    }
  };

  const handleDeleteLowBalanceRule = (rule: LowBalanceRule) => {
    setPendingDeleteRule(rule);
  };

  const handleConfirmDeleteLowBalanceRule = async () => {
    if (!pendingDeleteRule) {
      return;
    }

    const deleteId = pendingDeleteRule.id;
    setMutatingRuleIds((prev) => new Set(prev).add(deleteId));
    const response = await handleApiCall(
      () =>
        deleteWalletLowBalance({
          client: apiClient,
          body: {
            ruleId: deleteId,
          },
        }),
      {
        onError: (mutationError: unknown) => {
          toast.error(extractApiErrorMessage(mutationError, 'Failed to delete low-balance rule'));
        },
        errorMessage: 'Failed to delete low-balance rule',
      },
    );
    setMutatingRuleIds((prev) => {
      const next = new Set(prev);
      next.delete(deleteId);
      return next;
    });
    setPendingDeleteRule(null);

    if (response) {
      toast.success('Low-balance rule deleted');
      await refreshWalletDetails();
      await invalidateWalletQueries();
    }
  };

  const handleCreateLowBalanceRule = async () => {
    if (!wallet) return;

    const assetMeta = getRuleAssetMetaFromPreset(
      newRuleAssetPreset,
      network,
      newRuleCustomAssetUnit,
    );
    const assetUnit = assetMeta.assetUnit.trim();
    const thresholdAmount = parseThresholdInputToRaw(
      newRuleThresholdInput,
      assetMeta.assetUnit,
      network,
    );

    if (!assetUnit) {
      toast.error('Asset unit is required.');
      return;
    }

    // Validate custom asset units even for plain monitoring rules; the
    // topup validation below only runs this check when auto top-up is on.
    if (newRuleAssetPreset === 'custom' && !CARDANO_NATIVE_ASSET_UNIT_PATTERN.test(assetUnit)) {
      toast.error(
        'Asset unit must be a valid Cardano asset unit: policy id followed by an asset name of at most 32 bytes.',
      );
      return;
    }

    if (thresholdAmount == null) {
      toast.error(
        assetMeta.decimals == null
          ? 'Threshold amount must be a whole number in raw on-chain units.'
          : `Threshold amount must be a valid ${assetMeta.label} value with up to ${assetMeta.decimals} decimals.`,
      );
      return;
    }

    const topupEnabled = wallet.type !== 'Funding' && newRuleTopupEnabled;
    const topupValidation = validateRuleTopupInput({
      enabled: topupEnabled,
      topupAmountInput: newRuleTopupAmountInput,
      assetUnit,
      network,
    });
    if (topupValidation.error) {
      toast.error(topupValidation.error);
      return;
    }

    setIsCreatingRule(true);
    const response = await handleApiCall(
      () =>
        postWalletLowBalance({
          client: apiClient,
          body: {
            walletId: wallet.id,
            assetUnit,
            thresholdAmount,
            enabled: newRuleEnabled,
            topupEnabled,
            ...(topupEnabled ? { topupAmount: topupValidation.rawTopupAmount ?? undefined } : {}),
          },
        }),
      {
        onError: (mutationError: unknown) => {
          toast.error(extractApiErrorMessage(mutationError, 'Failed to create low-balance rule'));
        },
        errorMessage: 'Failed to create low-balance rule',
      },
    );
    setIsCreatingRule(false);

    if (response) {
      toast.success('Low-balance rule created');
      setNewRuleAssetPreset('lovelace');
      setNewRuleCustomAssetUnit('');
      setNewRuleThresholdInput('');
      setNewRuleEnabled(true);
      setNewRuleTopupEnabled(false);
      setNewRuleTopupAmountInput('');
      await refreshWalletDetails();
      await invalidateWalletQueries();
    }
  };

  return {
    isWalletDetailsLoading,
    walletDetails,
    refreshWalletDetails,
    resetForNewWallet,
    ruleDrafts,
    updateRuleDraft,
    mutatingRuleIds,
    isCreatingRule,
    pendingDeleteRule,
    setPendingDeleteRule,
    newRuleAssetPreset,
    setNewRuleAssetPreset,
    newRuleCustomAssetUnit,
    setNewRuleCustomAssetUnit,
    newRuleThresholdInput,
    setNewRuleThresholdInput,
    newRuleEnabled,
    setNewRuleEnabled,
    newRuleTopupEnabled,
    setNewRuleTopupEnabled,
    newRuleTopupAmountInput,
    setNewRuleTopupAmountInput,
    handleSaveLowBalanceRule,
    handleDeleteLowBalanceRule,
    handleConfirmDeleteLowBalanceRule,
    handleCreateLowBalanceRule,
  };
}
