import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  onConfirm: () => void;
  isLoading?: boolean;
  requireConfirmation?: boolean;
  confirmationText?: string;
  confirmationLabel?: string;
  /**
   * The confirm button's wording. Defaults to "Confirm".
   *
   * Worth setting wherever the dialog is talking someone out of something: a
   * button that names the action ("Close anyway") is answerable on its own,
   * while "Confirm" only means anything to a reader who still has the question
   * in their head.
   */
  confirmLabel?: string;
  /**
   * A consequence the operator has to tick before the action is offered.
   *
   * For the case where the action is allowed but costly, and the cost falls on
   * something other than the thing being acted on — a head that still holds
   * escrows can be closed, but its escrows then settle on L1. A typed
   * confirmation is the wrong instrument there: it proves the operator can copy
   * a word, not that they read what it costs. Absent, the dialog is a plain
   * confirmation.
   */
  acknowledgementLabel?: string;
  /**
   * What is happening while `isLoading`, shown in place of nothing.
   *
   * Set it wherever the work outlives the dialog. The action is dispatched
   * before the spinner appears, so closing the window never cancels it — but a
   * spinner alone implies the opposite, and an operator who cannot tell waits
   * it out.
   */
  loadingNote?: string;
  /** Above elevated agent dialog (AI agents opened over transactions). */
  elevatedChildStack?: boolean;
  /** Above elevated-child dialogs (e.g. confirm inside wallet opened from elevated agent). */
  elevatedGrandchildStack?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  onConfirm,
  isLoading = false,
  requireConfirmation = false,
  confirmationText = 'DELETE',
  confirmationLabel,
  confirmLabel = 'Confirm',
  acknowledgementLabel,
  loadingNote,
  elevatedChildStack,
  elevatedGrandchildStack,
}: ConfirmDialogProps) {
  const [confirmationInput, setConfirmationInput] = useState('');
  const [isAcknowledged, setIsAcknowledged] = useState(false);
  const [isShaking, setIsShaking] = useState(false);
  const isConfirmationValid = !requireConfirmation || confirmationInput.trim() === confirmationText;
  const isAcknowledgementValid = acknowledgementLabel === undefined || isAcknowledged;
  const canConfirm = isConfirmationValid && isAcknowledgementValid;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setConfirmationInput('');
      // Reset with the dialog. The next thing asked about is a different head
      // with different consequences, and a tick carried over would answer for it.
      setIsAcknowledged(false);
      onClose();
    }
  };

  const handleConfirm = () => {
    if (canConfirm) {
      setConfirmationInput('');
      setIsAcknowledged(false);
      onConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        elevatedChildStack={elevatedChildStack}
        elevatedGrandchildStack={elevatedGrandchildStack}
      >
        <DialogHeader>
          <DialogTitle>{title ?? 'Confirm'}</DialogTitle>
        </DialogHeader>

        <div className="py-4 mb-20">
          <p className="text-sm text-muted-foreground whitespace-pre-line">
            {description ?? '...'}
          </p>

          {isLoading && loadingNote !== undefined && (
            <p className="mt-3 text-sm text-muted-foreground">{loadingNote}</p>
          )}

          {acknowledgementLabel !== undefined && (
            <label className="mt-4 flex items-start gap-3 text-sm cursor-pointer">
              <Checkbox
                checked={isAcknowledged}
                onCheckedChange={(checked) => setIsAcknowledged(checked === true)}
                disabled={isLoading}
                className="mt-0.5"
              />
              <span>{acknowledgementLabel}</span>
            </label>
          )}

          {requireConfirmation && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">
                  {confirmationLabel || `Type "${confirmationText}" to confirm`}
                </label>
                <CopyButton value={confirmationText} className="h-6 w-6" />
              </div>
              <div
                className={isShaking ? 'animate-shake' : ''}
                onAnimationEnd={() => setIsShaking(false)}
              >
                <Input
                  type="text"
                  value={confirmationInput}
                  onChange={(e) => setConfirmationInput(e.target.value)}
                  onBlur={() => {
                    if (confirmationInput.trim() && !isConfirmationValid) {
                      setIsShaking(true);
                    }
                  }}
                  placeholder={confirmationText}
                  disabled={isLoading}
                />
              </div>
              {confirmationInput.trim() && !isConfirmationValid && (
                <p className="text-xs text-destructive animate-slide-in-left">
                  The entered text does not match
                </p>
              )}
            </div>
          )}
        </div>

        <div
          className="flex justify-end p-4 gap-4 w-full border-t"
          style={{
            position: 'absolute',
            bottom: '0',
            left: '0',
          }}
        >
          {/* Never disabled. The work is already dispatched by the time this
              spins, so closing cannot cancel it — and disabling the only way
              out left an operator holding a dialog they could not dismiss. It
              stops offering to cancel once there is nothing left to cancel. */}
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {isLoading ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isLoading || !canConfirm}>
            <span className="transition-opacity duration-150">
              {isLoading ? <Spinner size={16} /> : confirmLabel}
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
