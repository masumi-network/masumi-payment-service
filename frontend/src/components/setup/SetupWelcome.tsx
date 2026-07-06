import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { Check } from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { cn } from '@/lib/utils';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAgentQueries } from '@/lib/queries/agent-cache';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { STEP_LABELS, type SetupWallet } from '@/components/setup/setup-helpers';
import { WelcomeScreen } from '@/components/setup/screens/WelcomeScreen';
import { SeedPhrasesScreen } from '@/components/setup/screens/SeedPhrasesScreen';
import { PaymentSourceSetupScreen } from '@/components/setup/screens/PaymentSourceSetupScreen';
import { AddAiAgentScreen } from '@/components/setup/screens/AddAiAgentScreen';
import { SuccessScreen } from '@/components/setup/screens/SuccessScreen';

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset wizard state when network changes (user switched network during setup)
    setCurrentStep(0);
    setWallets({ buying: null, selling: null });
  }, [networkType]);

  // If the current network already has a V2 payment source and we're on the welcome step,
  // exit setup automatically. Legacy V1-only networks should still be able to migrate.
  useEffect(() => {
    const hasV2SourceForNetwork = paymentSources.some(
      (ps) => ps.network === networkType && isV2PaymentSource(ps),
    );
    if (currentStep === 0 && hasV2SourceForNetwork) {
      setIsSetupMode(false);
      router.push('/');
    }
  }, [networkType, paymentSources, currentStep, setIsSetupMode, router]);

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

  const totalSteps = steps.length;
  const showStepper = currentStep > 0 && currentStep < totalSteps - 1;
  const stepperSteps = STEP_LABELS.slice(1, -1);

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {showStepper && (
        <div className="mb-8 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-medium">{STEP_LABELS[currentStep]}</p>
              <p className="text-xs text-muted-foreground">
                Step {currentStep} of {stepperSteps.length}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {stepperSteps.map((label, i) => {
                const stepIndex = i + 1;
                const isComplete = currentStep > stepIndex;
                const isCurrent = currentStep === stepIndex;
                return (
                  <div key={stepIndex} className="flex items-center gap-2">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all duration-300',
                        isComplete && 'bg-primary text-primary-foreground ring-2 ring-primary/20',
                        isCurrent &&
                          'bg-primary text-primary-foreground ring-4 ring-primary/20 scale-110',
                        !isComplete && !isCurrent && 'bg-muted text-muted-foreground',
                      )}
                      title={label}
                    >
                      {isComplete ? <Check className="h-4 w-4 animate-pop-in" /> : stepIndex}
                    </div>
                    {i < stepperSteps.length - 1 && (
                      <div
                        className={cn(
                          'h-0.5 w-6 rounded-full transition-all duration-500',
                          currentStep > stepIndex + 1 ? 'bg-primary' : 'bg-muted',
                        )}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${((currentStep - 1) / (stepperSteps.length - 1)) * 100}%` }}
            />
          </div>
        </div>
      )}
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-260px)] py-8">
        <div key={currentStep} className="animate-slide-in-right w-full">
          {steps[currentStep]}
        </div>
      </div>
    </div>
  );
}
