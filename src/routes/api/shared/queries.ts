/**
 * Build transaction history include with optional limit
 * Used for conditional includeHistory behavior in query endpoints
 */
export function buildTransactionHistoryInclude(includeHistory: boolean) {
  return {
    orderBy: { createdAt: 'desc' as const },
    take: includeHistory ? undefined : 0,
  };
}
