import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postWallet } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import type { SetupWallet } from '@/components/setup/setup-helpers';

/**
 * Generates the buying + selling setup wallets on mount. Extracted verbatim
 * from SeedPhrasesScreen: state and the generation effect move here, the
 * screen keeps its own reveal/confirm UI state.
 */
export function useWalletGeneration() {
  const { apiClient, network } = useAppContext();
  const [isGenerating, setIsGenerating] = useState(true);
  const [buyingWallet, setBuyingWallet] = useState<SetupWallet | null>(null);
  const [sellingWallet, setSellingWallet] = useState<SetupWallet | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const generateWallets = async () => {
      setIsGenerating(true);
      setError('');

      // Type inferred from postWallet via handleApiCall's generic T.
      const buyingResponse = await handleApiCall(
        () =>
          postWallet({
            client: apiClient,
            body: {
              network: network,
            },
          }),
        {
          onError: (error: unknown) => {
            setError(extractApiErrorMessage(error, 'Failed to generate buying wallet'));
            toast.error('Failed to generate buying wallet');
          },
          errorMessage: 'Failed to generate buying wallet',
        },
      );

      // isGenerating stays true until BOTH wallets have finished — clearing it after
      // only the buying wallet would render a blank selling card and enable the
      // "I have saved both seed phrases" checkbox with one phrase on screen.
      if (!buyingResponse) {
        setIsGenerating(false);
        return;
      }

      if (
        !buyingResponse?.data?.data?.walletMnemonic ||
        !buyingResponse?.data?.data?.walletAddress
      ) {
        setError('Failed to generate buying wallet');
        toast.error('Failed to generate buying wallet');
        setIsGenerating(false);
        return;
      }

      setBuyingWallet({
        address: buyingResponse.data.data.walletAddress,
        mnemonic: buyingResponse.data.data.walletMnemonic,
      });

      // Type inferred from postWallet via handleApiCall's generic T.
      const sellingResponse = await handleApiCall(
        () =>
          postWallet({
            client: apiClient,
            body: {
              network: network,
            },
          }),
        {
          onError: (error: unknown) => {
            setError(extractApiErrorMessage(error, 'Failed to generate selling wallet'));
            toast.error('Failed to generate selling wallet');
          },
          onFinally: () => {
            setIsGenerating(false);
          },
          errorMessage: 'Failed to generate selling wallet',
        },
      );

      if (!sellingResponse) return;

      if (
        !sellingResponse?.data?.data?.walletMnemonic ||
        !sellingResponse?.data?.data?.walletAddress
      ) {
        setError('Failed to generate selling wallet');
        toast.error('Failed to generate selling wallet');
        return;
      }

      setSellingWallet({
        address: sellingResponse.data.data.walletAddress,
        mnemonic: sellingResponse.data.data.walletMnemonic,
      });
    };

    generateWallets();
  }, [apiClient, network]);

  return { isGenerating, buyingWallet, sellingWallet, error };
}
