import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { patchWallet } from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext } from '@/lib/contexts/AppContext';
import { invalidateTransactionReportFacets } from '@/lib/queries/transaction-report-cache';
import { handleApiCall, validateCardanoAddress } from '@/lib/utils';
import { fetchAllUtxos } from '@/lib/wallet-balance';
import type { WalletWithBalance } from '@/components/wallets/wallet-details-utils';

export function normalizeCollectionAddress(value: string): string | null {
  return value.trim() || null;
}

/**
 * Says what an on-chain lookup proved about a collection address. A lookup that
 * failed proves nothing, so it must never read as "this address is unused".
 */
export function describeCollectionAddressUsage(utxoCount: number | null): string | null {
  if (utxoCount === null) {
    return 'Could not check this collection address on chain, please verify it yourself';
  }
  if (utxoCount === 0) {
    return 'Collection address has not been used yet, please check if this is the correct address';
  }
  return null;
}

export function resolveCollectionAddress(
  savedCollectionAddress: string | null | undefined,
  walletCollectionAddress: string | null | undefined,
): string | null {
  return savedCollectionAddress !== undefined
    ? savedCollectionAddress
    : (walletCollectionAddress ?? null);
}

export function useCollectionAddressEditor({
  wallet,
  invalidateWalletQueries,
}: {
  wallet: WalletWithBalance | null;
  invalidateWalletQueries: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const { apiClient, network } = useAppContext();
  // save() awaits two network round trips. The dialog can switch wallet in that
  // time, so the completion has to know which wallet it started on.
  const activeWalletIdRef = useRef<string | null>(wallet?.id ?? null);
  useEffect(() => {
    activeWalletIdRef.current = wallet?.id ?? null;
  }, [wallet?.id]);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // `undefined` means no local save yet. Null means the user cleared the address.
  const [savedCollectionAddress, setSavedCollectionAddress] = useState<string | null | undefined>(
    undefined,
  );

  const collectionAddress = resolveCollectionAddress(
    savedCollectionAddress,
    wallet?.collectionAddress,
  );

  const startEdit = () => {
    setIsEditing(true);
    setDraft(collectionAddress || '');
  };

  const save = async () => {
    if (!wallet) return;
    const savingWalletId = wallet.id;

    const normalizedAddress = normalizeCollectionAddress(draft);
    if (normalizedAddress) {
      const validation = validateCardanoAddress(normalizedAddress, network);
      if (!validation.isValid) {
        toast.error('Invalid collection address: ' + validation.error);
        return;
      }

      let utxoCount: number | null = null;
      try {
        utxoCount = (await fetchAllUtxos(apiClient, network, normalizedAddress)).length;
      } catch {
        // Leave the count unknown. A failed lookup is not evidence of an unused address.
      }
      const usageWarning = describeCollectionAddressUsage(utxoCount);
      if (usageWarning) {
        toast.warning(usageWarning);
      }
    }

    await handleApiCall(
      () =>
        patchWallet({
          client: apiClient,
          body: {
            id: wallet.id,
            newCollectionAddress: normalizedAddress,
          },
        }),
      {
        onSuccess: () => {
          toast.success('Collection address updated successfully');
          // Only touch editor state that still belongs to the saved wallet.
          // Writing it back after a switch showed the previous wallet's address
          // on the new one, and a later save persisted it there.
          if (activeWalletIdRef.current === savingWalletId) {
            setIsEditing(false);
            setSavedCollectionAddress(normalizedAddress);
          }
          void invalidateWalletQueries();
          void invalidateTransactionReportFacets(queryClient);
        },
        onError: (error: unknown) => {
          toast.error(extractApiErrorMessage(error, 'Failed to update collection address'));
        },
        errorMessage: 'Failed to update collection address',
      },
    );
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setDraft('');
  };

  return {
    cancelEdit,
    collectionAddress,
    draft,
    isEditing,
    // A dialog that switches to another wallet must drop the whole editor, not
    // just the saved value: a draft left over from the previous wallet would be
    // saved onto the new one.
    resetForNewWallet: () => {
      setIsEditing(false);
      setDraft('');
      setSavedCollectionAddress(undefined);
    },
    save,
    setDraft,
    startEdit,
  };
}
