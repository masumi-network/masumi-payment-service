export type X402SetupStep = 0 | 1 | 2 | 3 | 4;

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
