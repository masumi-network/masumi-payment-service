import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { extractApiPayload } from '@/lib/api-response';
import { postX402Wallets, PostX402WalletsData, X402WalletCreated } from '@/lib/api/generated';
import type { X402WalletKeySource, X402WalletType } from '@/lib/x402-wallet-key';

/**
 * Creates a managed x402 wallet bound to one chain. Returns the created wallet, or null when
 * the request failed (the mutation already toasted the error).
 *
 * A generated key is returned exactly once. If the server ever omits it, the wallet is
 * unrecoverable, so this warns loudly instead of reporting success.
 */
export function useCreateX402Wallet() {
  const { apiClient } = useAppContext();
  const mutation = useApiMutation({
    mutationFn: (body: NonNullable<PostX402WalletsData['body']>) =>
      postX402Wallets({ client: apiClient, body }),
    errorMessage: 'Failed to create wallet',
  });

  const createWallet = async ({
    networkId,
    type,
    keySource,
    privateKey,
  }: {
    networkId: string;
    type: X402WalletType;
    keySource: X402WalletKeySource;
    /** Already validated with parseImportedPrivateKey when keySource is 'import'. */
    privateKey?: string;
  }): Promise<X402WalletCreated | null> => {
    const response = await mutation
      // An import never falls back to generating a key: a missing key is sent as empty and
      // rejected by the server rather than silently creating a wallet the operator never saw.
      .mutateAsync(
        keySource === 'import'
          ? { networkId, type, privateKey: privateKey ?? '' }
          : { networkId, type },
      )
      .catch(() => null);
    if (!response) return null;
    const created = extractApiPayload<X402WalletCreated>(response);
    if (!created) return null;
    if (keySource === 'generate' && !created.privateKey) {
      toast.error(
        'Wallet was created but its private key was not returned, so it cannot be recovered. Retire it and create a new one.',
      );
    }
    return created;
  };

  return { createWallet, isCreating: mutation.isPending };
}
