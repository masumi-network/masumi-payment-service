import { useState } from 'react';
import { toast } from 'react-toastify';
import { z } from 'zod';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postPaymentSourceExtended } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import { DEFAULT_ADMIN_WALLETS } from '@/lib/constants/defaultWallets';
import { DEFAULT_PAYMENT_SOURCE_TYPE } from '@/lib/payment-source-type';
import type { SetupWallet } from '@/components/setup/setup-helpers';

export const paymentSourceSchema = z.object({
  blockfrostApiKey: z.string().min(1, 'Blockfrost API key is required'),
  requiredAdminSignatures: z.number().int().min(1).max(3),
});

export type PaymentSourceFormValues = z.infer<typeof paymentSourceSchema>;

async function validateBlockfrostApiKey(
  apiKey: string,
  network: string,
): Promise<{ valid: boolean; error?: string }> {
  const baseUrl =
    network === 'Mainnet'
      ? 'https://cardano-mainnet.blockfrost.io/api/v0'
      : 'https://cardano-preprod.blockfrost.io/api/v0';

  try {
    const res = await fetch(`${baseUrl}/`, {
      headers: { project_id: apiKey },
    });

    if (res.status === 403 || res.status === 401) {
      // A 403 from the network-specific endpoint means the key is either
      // invalid or belongs to a different network (e.g. mainnet key on preprod endpoint).
      const expectedNetwork = network === 'Mainnet' ? 'Mainnet' : 'Preprod';
      return {
        valid: false,
        error: `Invalid Blockfrost API key. Please ensure the key is valid and belongs to the ${expectedNetwork} network.`,
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        error: `Blockfrost returned an error (HTTP ${res.status}). Please verify your API key.`,
      };
    }

    // 200 from the network-specific endpoint confirms the key is valid for this network.
    return { valid: true };
  } catch {
    return {
      valid: false,
      error: 'Unable to reach Blockfrost. Please check your internet connection and try again.',
    };
  }
}

/**
 * Owns the V2 payment-source creation flow for the setup wizard: Blockfrost
 * key validation, the create call, and the isLoading/error surface. Extracted
 * verbatim from PaymentSourceSetupScreen — the screen keeps its own form state
 * and passes the validated values into `createPaymentSource`.
 */
export function usePaymentSourceSetup() {
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const adminWallets = DEFAULT_ADMIN_WALLETS[network];

  const createPaymentSource = async (
    data: PaymentSourceFormValues,
    buyingWallet: SetupWallet | null,
    sellingWallet: SetupWallet | null,
    onSuccess: () => void,
  ) => {
    if (!buyingWallet || !sellingWallet) {
      setError('Buying and selling wallets are required');
      return;
    }

    setIsLoading(true);
    setError('');

    // Validate Blockfrost API key before creating payment source
    const validation = await validateBlockfrostApiKey(data.blockfrostApiKey, network);
    if (!validation.valid) {
      const msg = validation.error ?? 'Invalid Blockfrost API key.';
      setError(msg);
      toast.error(msg);
      setIsLoading(false);
      return;
    }

    await handleApiCall(
      () =>
        postPaymentSourceExtended({
          client: apiClient,
          body: {
            network: network,
            paymentSourceType: DEFAULT_PAYMENT_SOURCE_TYPE,
            PaymentSourceConfig: {
              rpcProviderApiKey: data.blockfrostApiKey,
              rpcProvider: 'Blockfrost',
            },
            feeRatePermille: 0,
            AdminWallets: adminWallets.map((w) => ({
              walletAddress: w.walletAddress,
            })),
            requiredAdminSignatures: data.requiredAdminSignatures,
            PurchasingWallets: [
              {
                walletMnemonic: buyingWallet.mnemonic,
                collectionAddress: null,
                note: 'Setup Buying Wallet',
              },
            ],
            SellingWallets: [
              {
                walletMnemonic: sellingWallet.mnemonic,
                collectionAddress: null,
                note: 'Setup Selling Wallet',
              },
            ],
          },
        }),
      {
        onSuccess: () => {
          toast.success('V2 payment source created successfully');
          onSuccess();
        },
        onError: (error: unknown) => {
          let msg = extractApiErrorMessage(error, 'Failed to create payment source');
          const normalizedMessage = msg.toLowerCase();

          // Check for Blockfrost-specific errors
          if (
            normalizedMessage.includes('invalid project token') ||
            normalizedMessage.includes('unauthorized') ||
            normalizedMessage.includes('403') ||
            normalizedMessage.includes('invalid api key')
          ) {
            msg = 'Invalid Blockfrost API key. Please check your key and try again.';
          } else if (
            normalizedMessage.includes('mainnet') ||
            normalizedMessage.includes('preprod') ||
            normalizedMessage.includes('testnet') ||
            normalizedMessage.includes('network mismatch') ||
            normalizedMessage.includes('wrong network')
          ) {
            const expectedNetwork = network === 'Mainnet' ? 'Mainnet' : 'Preprod';
            msg = `Your Blockfrost API key is for the wrong network. Please use a ${expectedNetwork} API key.`;
          } else if (
            normalizedMessage.includes('blockfrost') ||
            normalizedMessage.includes('rpc')
          ) {
            msg =
              'Unable to connect to Blockfrost. Please verify your API key is valid and for the correct network.';
          }

          setError(msg);
          toast.error(msg);
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to create payment source',
      },
    );
  };

  return { isLoading, error, adminWallets, createPaymentSource };
}
