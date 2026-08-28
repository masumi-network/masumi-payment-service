export type RegisterAgentDialogStep = 'form' | 'review';

export function getRegisterAgentReviewStepButtonLabel(input: {
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
}): string {
  if (input.isUpdateMode) return 'Review update';
  if (input.isReRegisterMode) return 'Review re-registration';
  return 'Review';
}

export function getRegisterAgentReviewTitle(input: {
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
}): string {
  if (input.isUpdateMode) return 'Review update';
  if (input.isReRegisterMode) return 'Review re-registration';
  return 'Review registration';
}

export function getRegisterAgentConfirmButtonLabel(input: {
  isSubmitting: boolean;
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
}): string {
  if (input.isSubmitting) {
    if (input.isUpdateMode) return 'Updating...';
    if (input.isReRegisterMode) return 'Re-registering...';
    return 'Registering...';
  }
  if (input.isUpdateMode) return 'Confirm update';
  if (input.isReRegisterMode) return 'Confirm re-registration';
  return 'Confirm registration';
}
