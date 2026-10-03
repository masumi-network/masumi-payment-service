import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { useRailReadiness } from '@/lib/hooks/useRailReadiness';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { postX402Networks, PostX402NetworksData, type X402Network } from '@/lib/api/generated';
import { isTestnetEnv, isX402ChainUsable, walletsForNetworks } from '@/lib/x402-rail';
import {
  buildEnableReceivingBody,
  initialX402SetupStep,
  pickInitialX402Chain,
  X402_ADD_SOURCE_STEP_LABELS,
  X402_SETUP_STEP_LABELS,
  X402_SETUP_STEPS,
  type X402SetupStep,
} from '@/lib/x402-setup';

export type X402Receiver = Parameters<typeof buildEnableReceivingBody>[1];

/**
 * State and actions for the x402 setup wizard. The screens only render what this returns and
 * call its actions, so the flow order, the context the wizard infers (chain, receive mode,
 * existing wallets) and every write live here.
 */
export function useX402SetupController({
  networkType,
  isAddingPaymentSource,
}: {
  networkType: NetworkType;
  isAddingPaymentSource: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    apiClient,
    authorized,
    selectedX402ChainId,
    setActiveRail,
    setSelectedX402ChainId,
    setIsSetupMode,
    setSetupWizardStep,
  } = useAppContext();
  const { wallets, isLoading: walletsLoading } = useX402Wallets();
  const { networks, isLoading: networksLoading } = useX402Networks({ network: networkType });
  const {
    x402: readiness,
    isLoading: readinessLoading,
    isUnavailable: isReadinessUnavailable,
  } = useRailReadiness({ network: networkType });

  const [currentStep, setCurrentStep] = useState<X402SetupStep>(X402_SETUP_STEPS.welcome);
  const [isAddSourceMode, setIsAddSourceMode] = useState(false);
  // A chain saved in the wizard is shown at once, before the network list refetches.
  const [savedChain, setSavedChain] = useState<X402Network | null>(null);
  const hasInitializedStepRef = useRef(false);

  // The x402 hooks return [] until authorized, which would read as "nothing configured".
  const isLoading = !authorized || walletsLoading || networksLoading || readinessLoading;

  const chains = useMemo(() => {
    const wantTestnet = isTestnetEnv(networkType);
    const matching = networks.filter((chain) => chain.isTestnet === wantTestnet);
    if (savedChain?.isTestnet !== wantTestnet || matching.some((c) => c.id === savedChain.id)) {
      return matching;
    }
    return [...matching, savedChain];
  }, [networks, networkType, savedChain]);
  const chainWallets = useMemo(() => walletsForNetworks(wallets, chains), [wallets, chains]);
  const selectedChain = pickInitialX402Chain(chains, selectedX402ChainId);
  const sellingWallets = chainWallets.filter(
    (wallet) => wallet.type === 'Selling' && wallet.networkId === selectedChain?.id,
  );
  const purchasingWallets = chainWallets.filter(
    (wallet) => wallet.type === 'Purchasing' && wallet.networkId === selectedChain?.id,
  );
  const isReceivingReady = selectedChain ? isX402ChainUsable(selectedChain) : false;
  const facilitatorWallet =
    sellingWallets.find((wallet) => wallet.id === selectedChain?.facilitatorWalletId) ?? null;

  const stepLabels = isAddSourceMode ? X402_ADD_SOURCE_STEP_LABELS : X402_SETUP_STEP_LABELS;
  // The shell numbers welcome as 0 and success as labels + 1. Adding a source has no paying
  // step, so its success screen sits at shell index 3 while the wizard step stays `ready`.
  const shellStep = currentStep === X402_SETUP_STEPS.ready ? stepLabels.length + 1 : currentStep;

  useEffect(() => {
    hasInitializedStepRef.current = false;
    queueMicrotask(() => {
      setCurrentStep(X402_SETUP_STEPS.welcome);
      setIsAddSourceMode(false);
      setSavedChain(null);
    });
  }, [networkType, isAddingPaymentSource]);

  useEffect(() => {
    setSetupWizardStep(currentStep);
  }, [currentStep, setSetupWizardStep]);

  // Resume where the operator left off, once all three sources have loaded.
  useEffect(() => {
    if (isLoading || hasInitializedStepRef.current) return;
    hasInitializedStepRef.current = true;
    // Readiness is rail-wide (any chain), so resume on a chain that can actually receive.
    // Otherwise a remembered, unconfigured chain would skip straight past receiving.
    const resumeChain =
      selectedChain && isX402ChainUsable(selectedChain)
        ? selectedChain
        : (chains.find(isX402ChainUsable) ?? selectedChain);
    const isRailReady = readiness?.isReady ?? false;
    const isReadyForAddSource = isAddingPaymentSource && isRailReady;
    const nextStep = initialX402SetupStep({
      isReadinessKnown: !isReadinessUnavailable,
      isReceivingReady: isRailReady && !!resumeChain && isX402ChainUsable(resumeChain),
      isPayingReady: chainWallets.some(
        (wallet) => wallet.type === 'Purchasing' && wallet.networkId === resumeChain?.id,
      ),
      startAtChainSelection: isReadyForAddSource,
    });
    if (resumeChain && resumeChain.id !== selectedX402ChainId) {
      setSelectedX402ChainId(resumeChain.id);
    }
    queueMicrotask(() => {
      setIsAddSourceMode(isReadyForAddSource);
      setCurrentStep(nextStep);
    });
  }, [
    isAddingPaymentSource,
    isLoading,
    isReadinessUnavailable,
    chains,
    chainWallets,
    readiness?.isReady,
    selectedChain,
    selectedX402ChainId,
    setSelectedX402ChainId,
  ]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['x402-wallets'] }),
      queryClient.invalidateQueries({ queryKey: ['x402-networks'] }),
      // Readiness drives resume and the dashboard prompt; refetch it with the lists.
      queryClient.invalidateQueries({ queryKey: ['rail-readiness'] }),
    ]);

  const saveNetwork = useApiMutation({
    mutationFn: (body: NonNullable<PostX402NetworksData['body']>) =>
      postX402Networks({ client: apiClient, body }),
    errorMessage: 'Could not enable receiving on this chain',
  });

  // Covers the POST and the refetch after it, so the buttons stay busy until the step
  // shows the new state and a second click cannot send a second write.
  const [isEnablingReceiving, setIsEnablingReceiving] = useState(false);
  const isEnablingRef = useRef(false);

  /** Assigns the facilitator and switches the chain on in one write. */
  const enableReceiving = async (receiver: X402Receiver): Promise<boolean> => {
    if (!selectedChain || isEnablingRef.current) return false;
    isEnablingRef.current = true;
    setIsEnablingReceiving(true);
    try {
      const response = await saveNetwork
        .mutateAsync(buildEnableReceivingBody(selectedChain, receiver))
        .catch(() => null);
      if (!response?.data?.data) return false;
      toast.success(`Receiving enabled on ${selectedChain.displayName}`);
      await refresh();
      return true;
    } finally {
      isEnablingRef.current = false;
      setIsEnablingReceiving(false);
    }
  };

  const selectChain = (chain: X402Network) => setSelectedX402ChainId(chain.id);
  const chainSaved = (chain: X402Network) => {
    setSavedChain(chain);
    setSelectedX402ChainId(chain.id);
    void refresh();
  };

  /** Leaves setup on the x402 rail and opens `path` (the dashboard by default). */
  const finish = (path = '/x402/dashboard') => {
    if (selectedChain) setSelectedX402ChainId(selectedChain.id);
    setActiveRail('x402');
    setIsSetupMode(false);
    void refresh();
    router.push(path);
  };

  const goToStep = (step: X402SetupStep) => setCurrentStep(step);
  const goAfterReceive = () =>
    setCurrentStep(isAddSourceMode ? X402_SETUP_STEPS.ready : X402_SETUP_STEPS.pay);
  const leaveAddSource = () => router.push('/payment-sources');

  return {
    isLoading,
    isAddSourceMode,
    isReadinessUnavailable,
    currentStep,
    shellStep,
    stepLabels,
    chains,
    selectedChain,
    sellingWallets,
    purchasingWallets,
    facilitatorWallet,
    isReceivingReady,
    isEnablingReceiving,
    selectChain,
    chainSaved,
    enableReceiving,
    refresh,
    goToStep,
    goAfterReceive,
    leaveAddSource,
    finish,
  };
}

export type X402SetupController = ReturnType<typeof useX402SetupController>;
