import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAgentQueries } from '@/lib/queries/agent-cache';
import { invalidateTransactionReportFacets } from '@/lib/queries/transaction-report-cache';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { useRailReadiness } from '@/lib/hooks/useRailReadiness';
import { STEP_LABELS, type SetupWallet } from '@/components/setup/setup-helpers';
import { WelcomeScreen } from '@/components/setup/screens/WelcomeScreen';
import { SeedPhrasesScreen } from '@/components/setup/screens/SeedPhrasesScreen';
import { PaymentSourceSetupScreen } from '@/components/setup/screens/PaymentSourceSetupScreen';
import { AddAiAgentScreen } from '@/components/setup/screens/AddAiAgentScreen';
import { SuccessScreen } from '@/components/setup/screens/SuccessScreen';
import { SetupWizardShell } from '@/components/setup/wizard/SetupWizardShell';

export function SetupWelcome({ networkType }: { networkType: string }) {
  const { setSetupWizardStep, setIsSetupMode } = useAppContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [wallets, setWallets] = useState<{
    buying: SetupWallet | null;
    selling: SetupWallet | null;
  }>({
    buying: null,
    selling: null,
  });
  const [hasAiAgent, setHasAiAgent] = useState(false);
  const { paymentSources } = usePaymentSourceExtendedAll();
  const { cardano: cardanoReadiness, isUnavailable: isReadinessUnavailable } = useRailReadiness({
    network: networkType as 'Preprod' | 'Mainnet',
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset wizard state when network changes (user switched network during setup)
    setCurrentStep(0);
    setWallets({ buying: null, selling: null });
  }, [networkType]);

  // Exit only once V2 is actually ready — a half-created V2 row must not boot
  // legacy-only operators out of the wizard while migration is still impossible.
  useEffect(() => {
    const hasV2SourceForNetwork = paymentSources.some(
      (ps) => ps.network === networkType && isV2PaymentSource(ps),
    );
    const hasReadyV2SourceForNetwork = isReadinessUnavailable
      ? hasV2SourceForNetwork
      : cardanoReadiness?.isReady === true && hasV2SourceForNetwork;
    if (currentStep === 0 && hasReadyV2SourceForNetwork) {
      setIsSetupMode(false);
      router.push('/');
    }
  }, [
    networkType,
    paymentSources,
    cardanoReadiness?.isReady,
    isReadinessUnavailable,
    currentStep,
    setIsSetupMode,
    router,
  ]);

  useEffect(() => {
    setSetupWizardStep(currentStep);
  }, [currentStep, setSetupWizardStep]);

  const exitSetup = (setIgnored = false) => {
    if (setIgnored) {
      localStorage.setItem('userIgnoredSetup', 'true');
    }
    setIsSetupMode(false);
    // Wallets, agents, transactions all keyed against the previous (often
    // empty) source set during setup. Invalidate the full set so the
    // dashboard the user lands on reflects what setup just created
    // (especially a step-3 AI agent that would otherwise be invisible
    // until the next refetch tick).
    queryClient.invalidateQueries({ queryKey: ['payment-sources-all'] });
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
    invalidateAgentQueries(queryClient);
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    void invalidateTransactionReportFacets(queryClient);
    router.push('/');
  };

  const handleCancel = () => {
    setWallets({ buying: null, selling: null });
    setCurrentStep(0);
  };

  const steps = [
    <WelcomeScreen key="welcome" onStart={() => setCurrentStep(1)} networkType={networkType} />,
    <SeedPhrasesScreen
      key="seed"
      onNext={(buying, selling) => {
        setWallets({ buying, selling });
        setCurrentStep(2);
      }}
      ignoreSetup={handleCancel}
    />,
    <PaymentSourceSetupScreen
      key="payment-source"
      onNext={() => setCurrentStep(3)}
      buyingWallet={wallets.buying}
      sellingWallet={wallets.selling}
      ignoreSetup={handleCancel}
    />,
    <AddAiAgentScreen
      key="ai"
      onNext={() => setCurrentStep(4)}
      sellingWallet={wallets.selling}
      ignoreSetup={() => exitSetup(true)}
      onAgentCreated={() => setHasAiAgent(true)}
    />,
    <SuccessScreen
      key="success"
      onComplete={() => exitSetup()}
      networkType={networkType}
      hasAiAgent={hasAiAgent}
    />,
  ];

  return (
    <SetupWizardShell stepLabels={STEP_LABELS.slice(1, -1)} currentStep={currentStep}>
      {steps[currentStep]}
    </SetupWizardShell>
  );
}
