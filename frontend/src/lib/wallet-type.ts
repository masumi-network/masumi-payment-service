import type { WalletListItem } from '@/lib/api/generated';

/**
 * Hot wallet types as the API reports them.
 *
 * Labels live here rather than inline at each call site because every hot
 * wallet type is reachable from any list that doesn't filter by type, and
 * there is no compiler signal when the enum grows: the dashboard, the wallets
 * table, global search and the type badge each had their own ternary, and
 * adding `Funding` silently mislabelled it in three of the four.
 */
/** Hot wallet types the API can return. */
export type HotWalletType = WalletListItem['type'];

/**
 * What the UI renders. `Collection` is a frontend-only pseudo-type: the
 * collection address is shown as a wallet-like row but is not a HotWallet and
 * has no server-side representation. Keep it out of `HotWalletType` so it can
 * never be sent to an endpoint that takes a real wallet type.
 */
export type DisplayWalletType = HotWalletType | 'Collection';

/**
 * Wallet types offered as filter tabs, in display order. Typed as
 * `HotWalletType[]` so a type removed from the API stops compiling here; a type
 * ADDED to the API will not appear until it is listed, which is deliberate —
 * showing a tab is a product decision, not an automatic consequence.
 */
export const WALLET_TYPE_TABS: HotWalletType[] = ['Purchasing', 'Selling', 'Funding'];

/** True for real hot wallet types, narrowing `Collection` out. */
export function isHotWalletType(type: DisplayWalletType): type is HotWalletType {
  return type !== 'Collection';
}

/** Noun for the wallet type, e.g. for badges. Not suffixed with "wallet". */
export function getWalletTypeLabel(type: DisplayWalletType): string {
  switch (type) {
    case 'Purchasing':
      return 'Buying';
    case 'Funding':
      return 'Funding';
    case 'Selling':
      return 'Selling';
    case 'Collection':
      return 'Collection';
  }
}

/** Sentence-case label including the word "wallet", e.g. table rows. */
export function getWalletTypeRowLabel(type: DisplayWalletType): string {
  return `${getWalletTypeLabel(type)} wallet`;
}

/** Title-case label including "Wallet", e.g. search results. */
export function getWalletTypeTitleLabel(type: DisplayWalletType): string {
  return `${getWalletTypeLabel(type)} Wallet`;
}
