/**
 * Which end of the payment a wallet is on.
 *
 * A head carries payments one way between a purchasing wallet and a selling
 * one, so this is the fact that decides what a participant can do — and until
 * it was shown, it was readable only by recognising which wallet address was
 * whose.
 *
 * "Purchasing" and "Selling" are the wallet's own vocabulary and stay that way
 * everywhere else; inside a head the useful reading is who pays and who is paid.
 */

import { Badge } from '@/components/ui/badge';

export type WalletRole = 'Purchasing' | 'Selling' | 'Funding';

/**
 * The counterparty's side, which a head fixes rather than stores.
 *
 * Remote participants save only the counterparty's keys, so their side has to
 * come from the local one. That is sound rather than a guess: the pairing is
 * settled when the invite is issued and cannot change for the head's life.
 */
export function counterpartRole(role: WalletRole | null | undefined): WalletRole | null {
  if (role === 'Purchasing') return 'Selling';
  if (role === 'Selling') return 'Purchasing';
  return null;
}

export function WalletRoleBadge({ role }: { role: WalletRole }) {
  if (role === 'Funding') {
    return (
      <Badge variant="outline" title="Funds nodes. Not a side of this payment.">
        Funding
      </Badge>
    );
  }

  const isBuyer = role === 'Purchasing';
  return (
    <Badge
      variant="secondary"
      title={
        isBuyer
          ? 'Buyer: this wallet pays into the head. Its counterparty sells.'
          : 'Seller: this wallet is paid from the head. Its counterparty buys.'
      }
    >
      {isBuyer ? 'Buyer' : 'Seller'}
    </Badge>
  );
}
