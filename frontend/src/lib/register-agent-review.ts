import type { MasumiOptionDraft, PaymentOptionRow } from '@/lib/agent-registration';
import type { X402OptionDraft } from '@/lib/x402-registration';
import { formatFundUnit, shortenAddress } from '@/lib/utils';
import type { NetworkType } from '@/lib/contexts/AppContext';

export type RegisterAgentDialogStep = 'form' | 'review';

export function getRegisterAgentReviewStepButtonLabel(_input: {
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
}): string {
  return 'Continue';
}

export function getRegisterAgentReviewTitle(input: {
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
}): string {
  if (input.isUpdateMode) return 'Review update';
  if (input.isReRegisterMode) return 'Review re-registration';
  return 'Review registration';
}

export function getRegisterAgentFormDescription(input: {
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
}): string {
  if (input.isUpdateMode) {
    return 'Updating the on-chain metadata issues an UpdateAction on the V2 registry contract: the existing asset is burned and a new asset with the incremented version is minted in a single transaction.';
  }
  if (input.isReRegisterMode) {
    return 'This mints a brand-new registration from the previous agent’s details. It is issued a new agent identifier; the old, deregistered one is not reused.';
  }
  return 'This registers your agent on the Masumi Network, making it visible to everyone.';
}

export function getRegisterAgentReviewDescription(input: {
  isUpdateMode: boolean;
  isReRegisterMode: boolean;
}): string {
  if (input.isUpdateMode) {
    return 'Check everything below before confirming the update. Use Back to change any field.';
  }
  if (input.isReRegisterMode) {
    return 'Check everything below before minting the new registration. Use Back to change any field.';
  }
  return 'Check everything below before registering. Use Back to change any field.';
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

export function formatMasumiOptionReviewSummary(
  option: MasumiOptionDraft,
  network: NetworkType,
): string {
  if (option.pricingType === 'Free') return 'Free';
  if (option.pricingType === 'Dynamic') return 'Dynamic pricing';
  const priceParts = option.prices
    .filter((price) => price.amount.trim().length > 0)
    .map((price) => {
      const unitLabel = formatFundUnit(
        price.unit === 'lovelace' ? 'lovelace' : price.unit,
        network,
      );
      return `${price.amount} ${unitLabel}`;
    });
  return priceParts.length > 0 ? priceParts.join(', ') : 'Fixed pricing (no amount set)';
}

export function formatX402OptionReviewSummary(option: X402OptionDraft): string {
  if (option.pricingType === 'Free') return 'Free';
  if (option.pricingType === 'Dynamic') {
    return option.caip2Network ? `Dynamic on ${option.caip2Network}` : 'Dynamic pricing';
  }
  const assetLabel = option.asset ? shortenAddress(option.asset, 6) : 'native asset';
  const amountLabel = option.amount.trim() ? option.amount : 'no amount set';
  const networkLabel = option.caip2Network || 'unknown network';
  return `${amountLabel} ${assetLabel} on ${networkLabel}`;
}

export function formatPaymentOptionReviewLine(input: {
  optionRow: PaymentOptionRow;
  optionIndex: number;
  masumiOption?: MasumiOptionDraft;
  x402Option?: X402OptionDraft;
  network: NetworkType;
}): { title: string; summary: string; detail?: string } {
  const title = `Payment option ${input.optionIndex + 1}`;
  if (input.optionRow.type === 'Masumi' && input.masumiOption) {
    return {
      title,
      summary: `Masumi · ${formatMasumiOptionReviewSummary(input.masumiOption, input.network)}`,
    };
  }
  if (input.optionRow.type === 'x402' && input.x402Option) {
    const payTo = input.x402Option.payTo.trim();
    return {
      title,
      summary: `x402 · ${formatX402OptionReviewSummary(input.x402Option)}`,
      detail: payTo ? `Pay to ${shortenAddress(payTo, 8)}` : undefined,
    };
  }
  return { title, summary: '—' };
}
