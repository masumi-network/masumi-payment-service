import type { WalletListItem } from '@/lib/api/generated';
import { shortenAddress } from '@/lib/utils';

type ReviewWallet = Pick<WalletListItem, 'walletAddress' | 'note'>;

function walletLabel(wallet: ReviewWallet): string {
  const address = shortenAddress(wallet.walletAddress, 8);
  return wallet.note ? `${wallet.note} (${address})` : address;
}

export function getMintingWalletLabel(
  isUpdateMode: boolean,
  holderAddress: string | undefined,
  selectedWallet: ReviewWallet | undefined,
): string {
  if (isUpdateMode) {
    return holderAddress ? shortenAddress(holderAddress, 8) : 'Current holder wallet';
  }
  return selectedWallet ? walletLabel(selectedWallet) : '—';
}

export function getHoldingWalletLabel(
  address: string | undefined,
  wallets: ReviewWallet[],
): string {
  if (!address) return 'Use minting wallet (default)';
  const wallet = wallets.find((wallet) => wallet.walletAddress === address);
  return wallet ? walletLabel(wallet) : shortenAddress(address, 8);
}
