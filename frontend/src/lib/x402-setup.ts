export type X402SetupStep = 0 | 1 | 2 | 3 | 4;

export function hasSpendableBudgetForChain(
  budgets: Array<{ caip2Network: string; remainingAmount: string }>,
  caip2Network?: string,
): boolean {
  if (!caip2Network) return false;
  return budgets.some(
    (budget) => budget.caip2Network === caip2Network && BigInt(budget.remainingAmount) > BigInt(0),
  );
}

export function initialX402SetupStep({
  isReadinessKnown,
  isReceivingReady,
  isPayingReady,
  startAtChainSelection = false,
}: {
  isReadinessKnown: boolean;
  isReceivingReady: boolean;
  isPayingReady: boolean;
  startAtChainSelection?: boolean;
}): X402SetupStep {
  if (startAtChainSelection) return 1;
  if (!isReadinessKnown || !isReceivingReady) return 0;
  return isPayingReady ? 4 : 3;
}
