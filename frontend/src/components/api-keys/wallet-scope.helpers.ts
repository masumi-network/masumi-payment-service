/**
 * Why a wallet scope cannot be saved, or undefined when it can.
 *
 * "Restrict to specific wallets" with nothing selected is not a narrow scope,
 * it is a deny-all. The middleware maps an enabled flag with no rows to `[]`
 * rather than `null`, and `null` is the value that means unrestricted, so
 * `buildHotWalletScopeFilter` turns it into `{ id: { in: [] } }`: a filter no
 * wallet matches. The key then reaches none of them, which is a state no
 * operator picks on purpose and nothing on screen names.
 *
 * Shared by the create and update dialogs, and by both scopes, so the rule and
 * its wording cannot drift between the four places that need it.
 */
export function walletScopeProblem(
  enabled: boolean,
  selectedIds: readonly string[],
): string | undefined {
  if (enabled && selectedIds.length === 0) {
    return 'Select at least one wallet, or turn the restriction off. An empty restriction blocks every wallet.';
  }
  return undefined;
}
