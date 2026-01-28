import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
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
}: ConfirmDialogProps) {
  const [confirmationInput, setConfirmationInput] = useState('');
  const [isConfirmationValid, setIsConfirmationValid] = useState(false);

  // Reset confirmation input when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setConfirmationInput('');
      setIsConfirmationValid(false);
    }
  }, [open]);

  // Validate confirmation input
  useEffect(() => {
    if (requireConfirmation) {
      setIsConfirmationValid(confirmationInput.trim() === confirmationText);
    } else {
      setIsConfirmationValid(true);
    }
  }, [confirmationInput, requireConfirmation, confirmationText]);

  const handleConfirm = () => {
    if (!requireConfirmation || isConfirmationValid) {
      onConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? 'Confirm'}</DialogTitle>
        </DialogHeader>

        <div className="py-4 mb-20">
          <p className="text-sm text-muted-foreground">{description ?? '...'}</p>

          {requireConfirmation && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">
                  {confirmationLabel || `Type "${confirmationText}" to confirm`}
                </label>
                <CopyButton value={confirmationText} className="h-6 w-6" />
              </div>
              <Input
                type="text"
                value={confirmationInput}
                onChange={(e) => setConfirmationInput(e.target.value)}
                placeholder={confirmationText}
                disabled={isLoading}
              />
              {confirmationInput.trim() && !isConfirmationValid && (
                <p className="text-xs text-destructive">The entered text does not match</p>
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
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isLoading || (requireConfirmation && !isConfirmationValid)}
          >
            {isLoading ? <Spinner size={16} /> : 'Confirm'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
