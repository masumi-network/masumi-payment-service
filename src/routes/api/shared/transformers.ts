import { HotWalletType } from '@prisma/client';

/**
 * Split hot wallets by type (Selling vs Purchasing)
 * Used in: payment-source, payment-source-extended (5+ times)
 */
export function splitWalletsByType<T extends { type: HotWalletType }>(
  wallets: T[],
) {
  return {
    SellingWallets: wallets.filter((w) => w.type === HotWalletType.Selling),
    PurchasingWallets: wallets.filter(
      (w) => w.type === HotWalletType.Purchasing,
    ),
  };
}

/**
 * Transform array of {unit, amount: bigint} to {unit, amount: string}
 * Used in: 15+ locations
 */
export function transformBigIntAmounts<
  T extends { unit: string; amount: bigint },
>(amounts: T[]): Array<{ unit: string; amount: string }> {
  return amounts.map((amount) => ({
    unit: amount.unit,
    amount: amount.amount.toString(),
  }));
}

/**
 * Transform single nullable BigInt to string
 */
export function transformNullableBigInt(
  value: bigint | null | undefined,
): string | null {
  return value != null ? value.toString() : null;
}

/**
 * Transform payment GET response amounts
 * Preserves existing patterns exactly
 */
export function transformPaymentGetAmounts(payment: {
  RequestedFunds: Array<{ unit: string; amount: bigint }>;
  WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
  WithdrawnForBuyer: Array<{ unit: string; amount: bigint }>;
}) {
  return {
    RequestedFunds: (
      payment.RequestedFunds as Array<{ unit: string; amount: bigint }>
    ).map((amount) => ({
      ...amount,
      amount: amount.amount.toString(),
    })),
    WithdrawnForSeller: (
      payment.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>
    ).map((amount) => ({
      unit: amount.unit,
      amount: amount.amount.toString(),
    })),
    WithdrawnForBuyer: (
      payment.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>
    ).map((amount) => ({
      unit: amount.unit,
      amount: amount.amount.toString(),
    })),
  };
}

/**
 * Transform purchase GET response amounts
 * Preserves existing patterns exactly
 */
export function transformPurchaseGetAmounts(purchase: {
  PaidFunds: Array<{ unit: string; amount: bigint }>;
  WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
  WithdrawnForBuyer: Array<{ unit: string; amount: bigint }>;
}) {
  return {
    PaidFunds: (
      purchase.PaidFunds as Array<{ unit: string; amount: bigint }>
    ).map((amount) => ({
      ...amount,
      amount: amount.amount.toString(),
    })),
    WithdrawnForSeller: (
      purchase.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>
    ).map((amount) => ({
      unit: amount.unit,
      amount: amount.amount.toString(),
    })),
    WithdrawnForBuyer: (
      purchase.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>
    ).map((amount) => ({
      unit: amount.unit,
      amount: amount.amount.toString(),
    })),
  };
}

/**
 * Transform payment GET response timestamps
 */
export function transformPaymentGetTimestamps(payment: {
  submitResultTime: bigint;
  payByTime: bigint | null;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  collateralReturnLovelace?: bigint | null;
  sellerCoolDownTime: bigint;
  buyerCoolDownTime: bigint;
}) {
  return {
    submitResultTime: payment.submitResultTime.toString(),
    payByTime: payment.payByTime?.toString() ?? null,
    unlockTime: payment.unlockTime.toString(),
    externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
    collateralReturnLovelace:
      payment.collateralReturnLovelace?.toString() ?? null,
    cooldownTime: Number(payment.sellerCoolDownTime),
    cooldownTimeOtherParty: Number(payment.buyerCoolDownTime),
  };
}

/**
 * Transform purchase GET response timestamps
 */
export function transformPurchaseGetTimestamps(purchase: {
  submitResultTime: bigint;
  payByTime: bigint | null;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  collateralReturnLovelace?: bigint | null;
  buyerCoolDownTime: bigint;
  sellerCoolDownTime: bigint;
}) {
  return {
    submitResultTime: purchase.submitResultTime.toString(),
    payByTime: purchase.payByTime?.toString() ?? null,
    unlockTime: purchase.unlockTime.toString(),
    externalDisputeUnlockTime: purchase.externalDisputeUnlockTime.toString(),
    collateralReturnLovelace:
      purchase.collateralReturnLovelace?.toString() ?? null,
    cooldownTime: Number(purchase.buyerCoolDownTime),
    cooldownTimeOtherParty: Number(purchase.sellerCoolDownTime),
  };
}
