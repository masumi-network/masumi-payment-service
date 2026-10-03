/** Shown when a non-admin key has no EVM chains in its chain limit. */
export function X402ChainLimitHint() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
      This API key has no EVM chains in its chain limit, so no x402 chains or payment activity can
      be shown. An admin can add the chain ids to the key.
    </div>
  );
}
