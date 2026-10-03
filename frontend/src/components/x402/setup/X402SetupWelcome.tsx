import { Spinner } from '@/components/ui/spinner';
import { SetupWizardShell } from '@/components/setup/wizard/SetupWizardShell';
import { X402ChainStep } from '@/components/x402/setup/X402ChainStep';
import { X402PayStep } from '@/components/x402/setup/X402PayStep';
import { X402ReceiveStep } from '@/components/x402/setup/X402ReceiveStep';
import { X402ReadyScreen, X402WelcomeScreen } from '@/components/x402/setup/X402SetupEndScreens';
import { useX402SetupController } from '@/components/x402/setup/useX402SetupController';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { X402_SETUP_STEPS } from '@/lib/x402-setup';

/**
 * Guided setup for the x402 (EVM) rail: chain, then receiving, then optional paying. Every
 * step does its own work in place (adding a chain, creating a wallet, choosing who settles),
 * so the operator only moves forward. State and writes live in `useX402SetupController`.
 */
export function X402SetupWelcome({
  networkType,
  isAddingPaymentSource = false,
}: {
  networkType: NetworkType;
  isAddingPaymentSource?: boolean;
}) {
  const controller = useX402SetupController({ networkType, isAddingPaymentSource });
  const { currentStep, shellStep, stepLabels, isLoading, isAddSourceMode, finish } = controller;

  const screen = (() => {
    if (isLoading) {
      return (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      );
    }
    switch (currentStep) {
      case X402_SETUP_STEPS.welcome:
        return <X402WelcomeScreen networkType={networkType} controller={controller} />;
      case X402_SETUP_STEPS.chain:
        return (
          <X402ChainStep
            networkType={networkType}
            chains={controller.chains}
            selectedChain={controller.selectedChain}
            isAddSourceMode={isAddSourceMode}
            onSelectChain={controller.selectChain}
            onChainSaved={controller.chainSaved}
            onBack={() =>
              isAddSourceMode
                ? controller.leaveAddSource()
                : controller.goToStep(X402_SETUP_STEPS.welcome)
            }
            onContinue={() =>
              isAddSourceMode && controller.isReceivingReady
                ? finish()
                : controller.goToStep(X402_SETUP_STEPS.receive)
            }
          />
        );
      case X402_SETUP_STEPS.receive:
        return <X402ReceiveStep controller={controller} />;
      case X402_SETUP_STEPS.pay:
        return <X402PayStep controller={controller} />;
      default:
        return <X402ReadyScreen controller={controller} />;
    }
  })();

  return (
    <SetupWizardShell stepLabels={stepLabels} currentStep={shellStep}>
      {screen}
    </SetupWizardShell>
  );
}
