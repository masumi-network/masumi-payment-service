import {
  deleteFundWallet,
  patchFundWallet,
  postFundDistributionTrigger,
  postFundWallet,
} from '@/lib/api/generated';
import type { PatchFundWalletData, PostFundWalletData } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useApiMutation } from '@/lib/hooks/useApiMutation';

/**
 * Write operations for the fund wallet of a payment source.
 *
 * Kept out of the dialog components so they hold only presentation + form
 * state; every mutation invalidates the fund-wallet read so the panel reflects
 * the server without manual refetching.
 */
export function useFundWalletMutations(paymentSourceId: string | null | undefined) {
  const { apiClient } = useAppContext();

  const invalidateKeys = [['fund-wallet', paymentSourceId], ['fund-distributions']];

  const createFundWallet = useApiMutation({
    mutationFn: (body: PostFundWalletData['body']) => postFundWallet({ client: apiClient, body }),
    invalidateKeys,
    errorMessage: 'Failed to create fund wallet',
  });

  const updateFundWallet = useApiMutation({
    mutationFn: (body: PatchFundWalletData['body']) => patchFundWallet({ client: apiClient, body }),
    invalidateKeys,
    errorMessage: 'Failed to update fund wallet',
  });

  const removeFundWallet = useApiMutation({
    // `force` skips the server's still-holds-funds guard. Surfaced as an
    // argument rather than hardcoded, so the caller has to opt in per click.
    mutationFn: (args: { id: string; force?: boolean }) =>
      deleteFundWallet({ client: apiClient, body: args }),
    invalidateKeys,
    errorMessage: 'Failed to delete fund wallet',
  });

  const triggerDistribution = useApiMutation({
    mutationFn: () => postFundDistributionTrigger({ client: apiClient, body: {} }),
    invalidateKeys,
    errorMessage: 'Failed to trigger distribution',
  });

  return { createFundWallet, updateFundWallet, removeFundWallet, triggerDistribution };
}
