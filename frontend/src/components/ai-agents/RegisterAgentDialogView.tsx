import type { ComponentProps } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PaymentOptionsSection } from './PaymentOptionsSection';
import { RegisterAgentDetailsSection } from './RegisterAgentDetailsSection';
import { RegisterAgentWalletSection } from './RegisterAgentWalletSection';
import { RegisterAgentAdditionalSection } from './RegisterAgentAdditionalSection';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { RegisterAgentReviewSection } from './RegisterAgentReviewSection';
import { Spinner } from '@/components/ui/spinner';
import { ArrowRight } from 'lucide-react';
import { VerificationsSection } from './VerificationsSection';
import {
  getRegisterAgentConfirmButtonLabel,
  getRegisterAgentFormDescription,
  getRegisterAgentReviewDescription,
  getRegisterAgentReviewStepButtonLabel,
  getRegisterAgentReviewTitle,
  type RegisterAgentDialogStep,
} from '@/lib/register-agent-review';

interface RegisterAgentDialogViewProps {
  open: boolean;
  onClose: () => void;
  elevatedChildStack?: boolean;
  step: RegisterAgentDialogStep;
  isLoading: boolean;
  isLoadingWallets: boolean;
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
  isV2Target: boolean;
  onBack: () => void;
  onReview: () => void;
  onConfirm: () => void;
  topUpWalletAddress: string | null;
  onTopUpClose: () => void;
  details: ComponentProps<typeof RegisterAgentDetailsSection>;
  wallet: ComponentProps<typeof RegisterAgentWalletSection>;
  paymentOptions: ComponentProps<typeof PaymentOptionsSection>;
  verifications: ComponentProps<typeof VerificationsSection>;
  additional: ComponentProps<typeof RegisterAgentAdditionalSection>;
  review: ComponentProps<typeof RegisterAgentReviewSection> | null;
}

export function RegisterAgentDialogView({
  open,
  onClose,
  elevatedChildStack,
  step,
  isLoading,
  isLoadingWallets,
  isUpdateMode,
  isReRegisterMode,
  isV2Target,
  onBack,
  onReview,
  onConfirm,
  topUpWalletAddress,
  onTopUpClose,
  details,
  wallet,
  paymentOptions,
  verifications,
  additional,
  review,
}: RegisterAgentDialogViewProps) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        size="lg"
        className="overflow-y-auto"
        elevatedChildStack={elevatedChildStack}
        hideClose={step === 'review'}
        onInteractOutside={(event) => {
          if (step !== 'review' || isLoading) return;
          event.preventDefault();
          onBack();
        }}
        onEscapeKeyDown={(event) => {
          if (step !== 'review' || isLoading) return;
          event.preventDefault();
          onBack();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {step === 'review'
              ? getRegisterAgentReviewTitle({ isUpdateMode, isReRegisterMode })
              : isUpdateMode
                ? 'Update AI Agent'
                : isReRegisterMode
                  ? 'Re-register AI Agent'
                  : 'Register AI Agent'}
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {step === 'review'
              ? getRegisterAgentReviewDescription({ isUpdateMode, isReRegisterMode })
              : getRegisterAgentFormDescription({ isUpdateMode, isReRegisterMode })}
          </p>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
          }}
          className="space-y-6"
        >
          {step === 'form' ? (
            <>
              <RegisterAgentDetailsSection {...details} />

              <RegisterAgentWalletSection {...wallet} />

              <PaymentOptionsSection {...paymentOptions} />

              {isV2Target && <VerificationsSection {...verifications} />}

              <RegisterAgentAdditionalSection {...additional} />
            </>
          ) : (
            review && <RegisterAgentReviewSection {...review} />
          )}

          <div className="flex justify-end items-center gap-2">
            {step === 'form' ? (
              <Button variant="outline" onClick={onClose} type="button">
                Cancel
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={onBack} disabled={isLoading}>
                Back
              </Button>
            )}
            <div className="flex items-center gap-2">
              {step === 'form' ? (
                <Button
                  type="button"
                  className="gap-2 btn-hover-lift group"
                  disabled={isLoadingWallets && !isUpdateMode}
                  onClick={onReview}
                >
                  {isLoadingWallets && !isUpdateMode && <Spinner size={14} />}
                  {getRegisterAgentReviewStepButtonLabel({
                    isUpdateMode,
                    isReRegisterMode,
                    isLoadingWallets,
                  })}
                  <ArrowRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-1"
                    aria-hidden
                  />
                </Button>
              ) : (
                <Button
                  type="button"
                  className="gap-2 btn-hover-lift group"
                  disabled={isLoading || !review}
                  onClick={onConfirm}
                >
                  {isLoading && <Spinner size={14} />}
                  {getRegisterAgentConfirmButtonLabel({
                    isSubmitting: isLoading,
                    isUpdateMode,
                    isReRegisterMode,
                  })}
                </Button>
              )}
            </div>
          </div>
        </form>
      </DialogContent>
      <TransakWidget
        isOpen={!!topUpWalletAddress}
        onClose={onTopUpClose}
        walletAddress={topUpWalletAddress ?? ''}
        isChild={!!elevatedChildStack}
        elevatedChildStack={!elevatedChildStack}
        elevatedGrandchildStack={elevatedChildStack}
      />
    </Dialog>
  );
}
